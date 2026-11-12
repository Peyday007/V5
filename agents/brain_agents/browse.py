"""A read-only Browser Use task: an LLM drives a real Chromium to find one fact.

Brain asks a narrow question about one website ("where does this business
publish its contact address?") and gets back an answer it can check. Three
properties make it safe to run unattended:

1. **It cannot act.** The agent's tools are the browser's reading half:
   navigate, click, scroll, go back, find text, extract. Typing, key presses,
   uploads, dropdown selection, arbitrary JavaScript, web search and files are
   removed (`READ_ONLY_EXCLUDED`), so it cannot fill a form, send a message,
   sign in, buy or commit to anything. Every such effect stays behind Brain's
   own authorization (CONTACT_BUYER grants, the effects engine).
2. **It stays on the site.** `allowed_domains` is the business's own domain;
   IP-literal hosts are blocked.
3. **Its answer is checked, not trusted.** The model's claimed values are
   looked for in the HTML of the page it cites, loaded again in the same
   browser. A value that is not on that page is returned as unverified, and
   Brain uses only verified ones (a small model invents plausible addresses).

The model is whatever OpenAI-compatible endpoint Brain passes per request —
in production the RunPod vLLM Brain already pays for — so this container holds
no model key of its own.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")

READ_ONLY_EXCLUDED = [
    "input", "send_keys", "upload_file", "select_dropdown", "evaluate", "search",
    "write_file", "replace_file", "read_file", "save_as_pdf", "screenshot",
]

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

TASK_FIND_CONTACT = (
    "You are on the website of a small business ({domain}). Find the email address the business "
    "itself publishes for customers (a contact page, footer, about or team page). Do not invent or "
    "guess an address: report only text you saw on a page. When done, report the address exactly as "
    "written and the URL of the page that shows it. If the site publishes no email address, say so "
    "with an empty email."
)


def chromium_path() -> str | None:
    """The Chromium Playwright installed in the image, unless one is named."""
    import glob

    named = os.environ.get("BRAIN_CHROMIUM")
    if named:
        return named
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright")
    found = sorted(glob.glob(f"{root}/chromium-*/chrome-linux*/chrome"))
    return found[-1] if found else None


def _llm(spec: dict):
    from browser_use import ChatOpenAI

    # Qwen3 on vLLM: "/no_think" in the system message keeps it out of its
    # thinking mode; structured output (guided decoding) does the rest.
    return ChatOpenAI(
        model=spec["model"],
        base_url=spec["baseUrl"],
        api_key=spec.get("apiKey") or "none",
        temperature=0.0,
        frequency_penalty=None,
        max_completion_tokens=2048,
        timeout=90,
        max_retries=1,
    )


async def _page_html(session, url: str) -> str:
    await session.navigate_to(url)
    await asyncio.sleep(1.5)
    cdp = await session.get_or_create_cdp_session()
    answer = await cdp.cdp_client.send.Runtime.evaluate(
        params={"expression": "document.documentElement.outerHTML", "returnByValue": True},
        session_id=cdp.session_id,
    )
    return str(((answer or {}).get("result") or {}).get("value") or "")


def _decode(html: str) -> str:
    """The page as a person reads it: entities and mailto: links unescaped."""
    import html as htmllib

    return htmllib.unescape(html).replace("%40", "@")


def verify_on_page(value: str, html: str) -> bool:
    if not value:
        return False
    return value.lower() in _decode(html).lower()


async def find_contact(domain: str, start_url: str, llm: dict, *, max_steps: int = 8, timeout_s: int = 240, model=None) -> dict:
    from pydantic import BaseModel
    from browser_use import Agent, BrowserProfile, BrowserSession, Tools

    class Answer(BaseModel):
        email: str
        source_url: str

    started = time.monotonic()
    profile = BrowserProfile(
        headless=True,
        allowed_domains=[domain, f"*.{domain}"],
        block_ip_addresses=True,
        chromium_sandbox=False,
        executable_path=chromium_path(),
        keep_alive=True,
    )
    session = BrowserSession(browser_profile=profile)
    tools = Tools(exclude_actions=READ_ONLY_EXCLUDED)
    model = model or _llm(llm)
    agent = Agent(
        task=TASK_FIND_CONTACT.format(domain=domain),
        llm=model,
        page_extraction_llm=model,
        browser_session=session,
        tools=tools,
        output_model_schema=Answer,
        use_vision=False,
        extend_system_message="/no_think",
        initial_actions=[{"navigate": {"url": start_url, "new_tab": False}}],
        max_failures=2,
        llm_timeout=90,
        step_timeout=120,
        calculate_cost=False,
        generate_gif=False,
        directly_open_url=False,
    )
    out: dict[str, Any] = {"domain": domain, "status": "ERROR", "email": None, "sourceUrl": None,
                           "verified": False, "steps": 0, "urls": [], "error": None}
    try:
        history = await asyncio.wait_for(agent.run(max_steps=max_steps), timeout=timeout_s)
        out["steps"] = history.number_of_steps()
        out["urls"] = [u for u in history.urls() if u][:20]
        parsed = None
        try:
            parsed = history.structured_output
        except Exception:
            parsed = None
        if parsed is None and history.final_result():
            try:
                parsed = Answer.model_validate(json.loads(history.final_result()))
            except Exception:
                parsed = None
        if parsed is None:
            out["status"] = "NO_ANSWER"
        else:
            email = (parsed.email or "").strip().removeprefix("mailto:")
            source = (parsed.source_url or "").strip()
            out["email"] = email or None
            out["sourceUrl"] = source or None
            if not email:
                out["status"] = "NONE_PUBLISHED"
            elif not EMAIL.fullmatch(email):
                out["status"] = "UNVERIFIED"
            else:
                pages = [source] if source else []
                pages += [u for u in out["urls"] if u not in pages]
                for page in pages[:3]:
                    try:
                        if verify_on_page(email, await _page_html(session, page)):
                            out["verified"], out["sourceUrl"] = True, page
                            break
                    except Exception:
                        continue
                out["status"] = "VERIFIED" if out["verified"] else "UNVERIFIED"
    except asyncio.TimeoutError:
        out["status"], out["error"] = "TIMEOUT", f"no answer within {timeout_s}s"
    except Exception as error:  # the agent's own failure, reported, never raised to Brain
        out["status"], out["error"] = "ERROR", f"{type(error).__name__}: {str(error)[:300]}"
    finally:
        try:
            await session.kill()
        except Exception:
            pass
    out["seconds"] = round(time.monotonic() - started, 1)
    return out
