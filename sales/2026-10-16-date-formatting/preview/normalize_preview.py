"""Preview of the date-normalisation core for Freelancer project 40771060.

This is a demonstration of the detection and rewrite rules only. It is not the
deliverable: the folder sweep, the scheduled/one-click launcher, Word/CSV
handling, the colleague set-up guide and tuning on the client's own files are
the paid work.

Rules shown here:
  * A cell that already holds a real date keeps its value and gets the
    DD-MM-YYYY display format, so formulas and lookups keep working.
  * A cell holding a date typed as text becomes a real date with that format.
  * A date inside a sentence or header is rewritten in place as DD-MM-YYYY.
  * Anything ambiguous (e.g. 03/04/2026, or a two-digit year) is resolved by a
    stated policy (day-first) and every such decision is written to the log.
  * Things that look like dates but are not (versions, decimals, phone
    numbers, invoice ids) are left alone.
"""
from __future__ import annotations

import datetime as dt
import re
import sys

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
ORD = r"(?:st|nd|rd|th)?"

PATTERNS = [
    # 2026-10-16, 2026/10/16
    ("ymd", re.compile(r"(?<![\d.])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\d.])")),
    # 16/10/2026, 10-16-2026, 16.10.26
    ("dmy_num", re.compile(r"(?<![\d.\w])(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?![\d.\w])")),
    # 16 Oct 2026, 16-Oct-2026, 16th October, 2026
    ("d_mon_y", re.compile(rf"(?<!\w)(\d{{1,2}}){ORD}[\s\-/]+{MON}\.?,?[\s\-/]+(\d{{4}})(?!\w)", re.I)),
    # Oct 16, 2026 / October 16th 2026
    ("mon_d_y", re.compile(rf"(?<!\w){MON}\.?\s+(\d{{1,2}}){ORD},?\s+(\d{{4}})(?!\w)", re.I)),
]


def _year(y: str) -> int:
    n = int(y)
    return n if len(y) == 4 else 2000 + n


def parse(m: re.Match, kind: str) -> tuple[dt.date, str | None] | None:
    """Return (date, note) or None if the match is not a valid date."""
    note = None
    try:
        if kind == "ymd":
            d = dt.date(int(m[1]), int(m[3]), int(m[4]))
        elif kind == "dmy_num":
            a, b, y = int(m[1]), int(m[3]), m[4]
            if len(y) == 2:
                note = f"two-digit year '{y}' read as {_year(y)}"
            if a > 12 and b <= 12:
                d = dt.date(_year(y), b, a)
            elif b > 12 and a <= 12:
                d = dt.date(_year(y), a, b)
                note = (note + "; " if note else "") + "month-first input detected (day > 12)"
            elif a <= 12 and b <= 12 and a != b:
                d = dt.date(_year(y), b, a)
                note = (note + "; " if note else "") + "ambiguous, day-first policy applied"
            else:
                d = dt.date(_year(y), b, a)
        elif kind == "d_mon_y":
            d = dt.date(int(m[3]), MONTHS[m[2][:3].lower()], int(m[1]))
        else:
            d = dt.date(int(m[3]), MONTHS[m[1][:3].lower()], int(m[2]))
    except ValueError:
        return None
    return d, note


IDENT_BEFORE = re.compile(r"([A-Za-z]{2,}[-_#/]|#)$")
VERSION_WORD = re.compile(r"\b(v|ver|version|build|release|rev)\.?\s*$", re.I)
SKIP_HEADERS = re.compile(r"version|build|\bid\b|code|invoice|ref|sku|phone", re.I)


def looks_like_identifier(text: str, m: re.Match, kind: str) -> str | None:
    before = text[: m.start()]
    if IDENT_BEFORE.search(before):
        return "part of an identifier"
    if VERSION_WORD.search(before):
        return "labelled as a version/build"
    if kind == "dmy_num" and m[2] == "." and len(m[4]) == 2 and len(m[1]) == 1:
        return "dotted short form reads as a version number"
    return None


def rewrite_text(text: str, log: list[str], where: str) -> str:
    for kind, pat in PATTERNS:
        def sub(m: re.Match) -> str:
            why = looks_like_identifier(text, m, kind)
            if why:
                log.append(f"{where}: '{m[0]}' left unchanged  [{why}]")
                return m[0]
            got = parse(m, kind)
            if got is None:
                return m[0]
            d, note = got
            new = d.strftime("%d-%m-%Y")
            if new != m[0]:
                log.append(f"{where}: '{m[0]}' -> '{new}'" + (f"  [{note}]" if note else ""))
            return new
        text = pat.sub(sub, text)
    return text


def whole_cell_date(text: str) -> dt.date | None:
    s = text.strip()
    for kind, pat in PATTERNS:
        m = pat.fullmatch(s)
        if m and not looks_like_identifier(s, m, kind):
            got = parse(m, kind)
            return got[0] if got else None
    return None


def run_xlsx(src: str, dst: str, log: list[str]) -> None:
    import openpyxl
    wb = openpyxl.load_workbook(src)
    for ws in wb.worksheets:
        skip_cols = {c.column for c in ws[1] if isinstance(c.value, str) and SKIP_HEADERS.search(c.value)}
        for row in ws.iter_rows():
            for c in row:
                where = f"{ws.title}!{c.coordinate}"
                if c.row > 1 and c.column in skip_cols:
                    if isinstance(c.value, str) and any(p.search(c.value) for _, p in PATTERNS):
                        log.append(f"{where}: '{c.value}' left unchanged  [column '{ws.cell(1, c.column).value}' is an identifier column]")
                    continue
                if isinstance(c.value, (dt.datetime, dt.date)):
                    if c.number_format != "DD-MM-YYYY":
                        log.append(f"{where}: real date kept, display format {c.number_format!r} -> 'DD-MM-YYYY'")
                        c.number_format = "DD-MM-YYYY"
                elif isinstance(c.value, str):
                    d = whole_cell_date(c.value)
                    if d is not None:
                        log.append(f"{where}: text date '{c.value}' -> real date shown as {d:%d-%m-%Y}")
                        c.value = d
                        c.number_format = "DD-MM-YYYY"
                    else:
                        c.value = rewrite_text(c.value, log, where)
    wb.save(dst)


def run_txt(src: str, dst: str, log: list[str]) -> None:
    out = []
    with open(src, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            out.append(rewrite_text(line, log, f"{src}:{i}"))
    with open(dst, "w", encoding="utf-8") as f:
        f.writelines(out)


if __name__ == "__main__":
    log: list[str] = []
    for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
        (run_xlsx if src.endswith(".xlsx") else run_txt)(src, dst, log)
    print("\n".join(log))
