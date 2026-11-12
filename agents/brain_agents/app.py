"""Brain's open-source agents, behind one narrow private HTTP interface.

    GET  /healthz              liveness and versions; no key, no detail
    POST /v1/sellbird/contacts {website}            -> who decides, published addresses
    POST /v1/browser/contact   {website, llm}       -> a read-only Browser Use task
    POST /v1/sellbird/research {website, offer?}    -> signals, facts, people, inbox, fit score
    POST /v1/sellbird/write    {offer, lead, llm}   -> one grounded first email, or why not
    POST /v1/sellbird/sequence {offer, sample, llm} -> a 3-step campaign sequence
    POST /v1/sellbird/reply    {offer, lead, reply, history, llm} -> Sellbird's decision on a reply
    POST /v1/sellbird/insights {report}             -> the analyst's findings
    POST /v1/sellbird/knowledge {llm, url|pages}    -> product facts, ICP, competition, objections
    POST /v1/sellbird/offers   {offer, llm}         -> free first-email offers that fit
    POST /v1/sellbird/deliverability {domain}       -> MX, SPF, DMARC, DKIM, blocklists

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
# Model work shares Brain's one GPU with its research lane: a few at a time.
_model_slots = asyncio.Semaphore(int(os.environ.get("BRAIN_AGENTS_MODEL", "3")))


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


# --------------------------------------------------------------------------- #
# Sellbird's sales mind (sales.py): Brain sends the business, the lead and its
# model; Sellbird's own code answers; nothing is sent or kept here.           #
# --------------------------------------------------------------------------- #

class ResearchRequest(BaseModel):
    website: str = Field(min_length=4, max_length=300)
    offer: dict | None = None
    titles: list[str] | None = Field(default=None, max_length=30)
    industry: str = Field(default="", max_length=100)


@app.post("/v1/sellbird/research", dependencies=[Depends(require_key)])
async def sellbird_research(body: ResearchRequest) -> dict:
    from .sales import as_json, research

    if not normalize_domain(body.website):
        raise HTTPException(status_code=400, detail="website is not a public domain")
    async with _sellbird_slots:
        try:
            return as_json(await asyncio.wait_for(
                research(body.website, body.offer, body.titles, body.industry), timeout=150))
        except asyncio.TimeoutError:
            return {"domain": normalize_domain(body.website), "error": "timeout"}


class WriteRequest(BaseModel):
    offer: dict
    lead: dict
    llm: LlmSpec


@app.post("/v1/sellbird/write", dependencies=[Depends(require_key)])
async def sellbird_write(body: WriteRequest) -> dict:
    from .sales import as_json, write_first_email

    async with _model_slots:
        try:
            return as_json(await asyncio.wait_for(write_first_email(body.offer, body.lead, body.llm.model_dump()), timeout=300))
        except asyncio.TimeoutError:
            return {"ok": False, "reason": "timeout"}


class SequenceRequest(BaseModel):
    offer: dict
    sample: list[dict] = Field(min_length=1, max_length=5)
    llm: LlmSpec


@app.post("/v1/sellbird/sequence", dependencies=[Depends(require_key)])
async def sellbird_sequence(body: SequenceRequest) -> dict:
    from .sales import as_json, write_sequence

    async with _model_slots:
        try:
            return as_json(await asyncio.wait_for(write_sequence(body.offer, body.sample, body.llm.model_dump()), timeout=420))
        except asyncio.TimeoutError:
            return {"ok": False, "steps": [], "reason": "timeout"}


class ReplyRequest(BaseModel):
    offer: dict
    lead: dict
    reply: dict
    history: list[dict] = Field(default_factory=list, max_length=40)
    llm: LlmSpec


@app.post("/v1/sellbird/reply", dependencies=[Depends(require_key)])
async def sellbird_reply(body: ReplyRequest) -> dict:
    from .sales import as_json, handle_reply

    if not str(body.reply.get("text") or "").strip() or "@" not in str(body.lead.get("email") or ""):
        raise HTTPException(status_code=400, detail="reply text and lead email are required")
    async with _model_slots:
        try:
            return as_json(await asyncio.wait_for(
                handle_reply(body.offer, body.lead, body.reply, body.history, body.llm.model_dump()), timeout=300))
        except asyncio.TimeoutError:
            return {"error": "timeout"}


class InsightsRequest(BaseModel):
    report: dict


@app.post("/v1/sellbird/insights", dependencies=[Depends(require_key)])
def sellbird_insights(body: InsightsRequest) -> dict:
    from .sales import insights

    return {"insights": insights(body.report)}


class KnowledgeRequest(BaseModel):
    llm: LlmSpec
    url: str = Field(default="", max_length=300)
    pages: dict[str, str] | None = None


@app.post("/v1/sellbird/knowledge", dependencies=[Depends(require_key)])
async def sellbird_knowledge(body: KnowledgeRequest) -> dict:
    from .sales import as_json, knowledge

    if not body.pages and not normalize_domain(body.url):
        raise HTTPException(status_code=400, detail="a public url or pages are required")
    async with _model_slots:
        try:
            return as_json(await asyncio.wait_for(knowledge(body.llm.model_dump(), body.url, body.pages), timeout=900))
        except asyncio.TimeoutError:
            return {"error": "timeout"}


class OffersRequest(BaseModel):
    offer: dict
    llm: LlmSpec


@app.post("/v1/sellbird/offers", dependencies=[Depends(require_key)])
async def sellbird_offers(body: OffersRequest) -> dict:
    from .sales import as_json, suggest_offers

    async with _model_slots:
        try:
            return as_json(await asyncio.wait_for(suggest_offers(body.offer, body.llm.model_dump()), timeout=300))
        except asyncio.TimeoutError:
            return {"ideas": [], "error": "timeout"}


class DeliverabilityRequest(BaseModel):
    domain: str = Field(min_length=4, max_length=253)
    dkimSelector: str = Field(default="", max_length=63)


@app.post("/v1/sellbird/deliverability", dependencies=[Depends(require_key)])
async def sellbird_deliverability(body: DeliverabilityRequest) -> dict:
    from .sales import deliverability

    if not normalize_domain(body.domain):
        raise HTTPException(status_code=400, detail="not a public domain")
    return {"domain": normalize_domain(body.domain),
            "checks": await asyncio.to_thread(deliverability, body.domain, body.dkimSelector)}
