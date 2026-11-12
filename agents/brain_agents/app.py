"""Brain's open-source agents, behind one narrow private HTTP interface.

    GET  /healthz              liveness and versions; no key, no detail
    POST /v1/sellbird/contacts {website}            -> who decides, published addresses
    POST /v1/browser/contact   {website, llm}       -> a read-only Browser Use task

Every /v1 call needs `Authorization: Bearer $BRAIN_AGENTS_KEY`. The app runs
on a Flycast (private) address only, so it is reachable from Brain's own Fly
organization and never from the internet; the key is the second lock.

Nothing here keeps state, sends a message or spends money. Brain owns the
prospect, the decision and the record (integration_events USAGE rows); this
service answers one question per request and forgets it.
"""
from __future__ import annotations

import asyncio
import hmac
import os
from importlib import metadata

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .contacts import find_contacts, normalize_domain

app = FastAPI(title="brain-agents", docs_url=None, redoc_url=None, openapi_url=None)

# One browser at a time on a 1 GB machine; Sellbird reads are light HTTP.
_browser_slots = asyncio.Semaphore(int(os.environ.get("BRAIN_AGENTS_BROWSERS", "1")))
_sellbird_slots = asyncio.Semaphore(int(os.environ.get("BRAIN_AGENTS_SELLBIRD", "6")))


def _version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "missing"


def require_key(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("BRAIN_AGENTS_KEY", "")
    given = authorization.removeprefix("Bearer ").strip()
    # One refusal for every failure: no key configured, none sent, wrong key.
    if not expected or not given or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "keyConfigured": bool(os.environ.get("BRAIN_AGENTS_KEY")),
        "agents": {"sellbird": _version("sellbird"), "browser-use": _version("browser-use")},
    }


class ContactsRequest(BaseModel):
    website: str = Field(min_length=4, max_length=300)
    titles: list[str] | None = Field(default=None, max_length=30)


@app.post("/v1/sellbird/contacts", dependencies=[Depends(require_key)])
async def sellbird_contacts(body: ContactsRequest) -> dict:
    if not normalize_domain(body.website):
        raise HTTPException(status_code=400, detail="website is not a public domain")
    async with _sellbird_slots:
        try:
            result = await asyncio.wait_for(find_contacts(body.website, titles=body.titles), timeout=90)
        except asyncio.TimeoutError:
            return {"domain": normalize_domain(body.website), "error": "timeout"}
    return result.as_dict()


class LlmSpec(BaseModel):
    baseUrl: str = Field(min_length=8, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    apiKey: str | None = Field(default=None, max_length=500)


class BrowserContactRequest(BaseModel):
    website: str = Field(min_length=4, max_length=300)
    llm: LlmSpec
    maxSteps: int = Field(default=8, ge=2, le=15)


@app.post("/v1/browser/contact", dependencies=[Depends(require_key)])
async def browser_contact(body: BrowserContactRequest) -> dict:
    from .browse import find_contact

    domain = normalize_domain(body.website)
    if not domain:
        raise HTTPException(status_code=400, detail="website is not a public domain")
    start = body.website if body.website.startswith("http") else f"https://{body.website}"
    async with _browser_slots:
        return await find_contact(domain, start, body.llm.model_dump(), max_steps=body.maxSteps)
