"""Builds a synthetic messy workbook and report — invented sample data, not the client's."""
import datetime as dt, openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Orders"
ws.append(["Order", "Ordered on", "Due (as of 1st Oct 2026)", "Note", "Version", "Amount"])
rows = [
 ("INV-2026/10/05", dt.datetime(2026, 10, 5), "16/10/2026", "Shipped Oct 3, 2026 via courier", "1.2.10", 12.10),
 ("INV-2026/10/06", "2026-10-06", "10/16/2026", "Customer called on 03/04/2026", "2.0.1", 1450.5),
 ("INV-2026/10/07", "7 Oct 2026", "16.10.26", "Re-sent 15th October, 2026", "3.1", 99.0),
]
for r in rows: ws.append(r)
ws["B2"].number_format = "mm/dd/yyyy"
ws["F1"].value = "Amount"
wb.save("sample_before.xlsx")
open("sample_report_before.txt", "w").write(
 "Weekly report for 2026-10-12 to 16/10/2026\n"
 "Meeting moved from October 14th 2026 to 15-Oct-2026. Call +91 98765 43210.\n"
 "Build 4.10.2026 is a version tag, not a date? (left as is if not a valid date)\n")
