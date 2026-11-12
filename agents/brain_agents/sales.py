"""Sellbird's sales mind, per request, thinking with Brain's own model (§104, §107).

Brain owns every prospect, campaign, conversation and decision; Instantly
sends. This module runs Sellbird's own code for the questions it answers well
and returns the answer — it sends nothing, stores nothing and keeps no state
between requests:

  research   collectors.profile.ProfileCollector.profile_company (free homepage
             signals: tools, ads, agency, schema, stale blog, hiring, startup
             facts), contacts.find_contacts (who decides, the published inbox),
             site_facts.site_facts (what the writer may say), fit.company_fit
             (Sellbird's 0-100 fit score and its reasons).
  write      agents.writer.Writer._write_personal_email -> humanize ->
             Writer._keep_to_rules: one grounded first email per person, from
             the facts above, within Sellbird's writing rules, or nothing.
  sequence   Writer._write_sequence: a campaign-level 3-step sequence with
             Instantly merge variables, for a campaign variant test.
  reply      agents.handler.Handler._process_reply, run against a throwaway
             state seeded with the conversation Brain holds: Sellbird's hard
             opt-out and escalation rules, its intent classifier, its stage
             machine, its drafted answer and its own send gate
             (gate.pre_send_check + gate.autopilot_review). The Instantly
             client is replaced by a recorder: Sellbird decides, Brain sends.
  insights   agents.analyst.Analyst._generate_insights over Brain's own
             campaign figures.
  knowledge  trainer.Trainer: product knowledge, objections and battle cards
             from a business's own pages (FallbackCrawler: free).

The model is Brain's (the RunPod vLLM it already runs), sent per request and
plugged into Sellbird's documented seam, ``Brain(transport=...)``. No paid
model API, no key held here. Qwen3's thinking is switched off with /no_think
and any <think> block is removed before Sellbird reads the answer.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from typing import Any

import httpx

from .contacts import DEFAULT_TITLES, find_contacts, normalize_domain

_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
MAX_TOKENS = 1600


# --------------------------------------------------------------------------- #
# The model seam                                                              #
# --------------------------------------------------------------------------- #

def transport_for(llm: dict, calls: list | None = None):
    """Sellbird's ``Brain(transport=...)`` over an OpenAI-compatible server."""
    base = str(llm.get("baseUrl") or "").rstrip("/")
    model = str(llm.get("model") or "")
    key = llm.get("apiKey") or None
    if not base.startswith(("http://", "https://")) or not model:
        raise ValueError("llm needs baseUrl and model")
    log = calls if calls is not None else []

    async def transport(prompt: str, *, agent: str = "", task: str = "", timeout: float = 120,
                        expect_json: bool = False) -> str:
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": "/no_think"},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.3,
            "max_tokens": MAX_TOKENS,
        }
        entry = {"agent": agent, "task": task, "ok": False}
        log.append(entry)
        try:
            async with httpx.AsyncClient(timeout=min(float(timeout or 120), 150.0)) as client:
                res = await client.post(f"{base}/chat/completions", json=body, headers=headers)
        except httpx.HTTPError as error:
            entry["status"] = type(error).__name__
            return ""
        if res.status_code >= 400:
            entry["status"] = res.status_code
            return ""
        text = ((res.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        text = _THINK.sub("", text).strip()
        entry["ok"] = bool(text)
        return text

    transport.calls = log  # type: ignore[attr-defined]
    return transport


# --------------------------------------------------------------------------- #
# A business, as Sellbird's config                                            #
# --------------------------------------------------------------------------- #

def build_config(offer: dict, titles: list[str] | None = None):
    """SellbirdConfig for one Brain business. ``offer`` comes from Brain."""
    from sellbird.config import SellbirdConfig

    sender = offer.get("sender") or {}
    product = offer.get("product") or {}
    return SellbirdConfig(
        persona={
            "name": str(sender.get("name") or offer.get("brand") or ""),
            "company": str(offer.get("brand") or ""),
            "role": str(sender.get("role") or "Owner"),
            "email": str(sender.get("email") or ""),
            "linkedin": "",
            "tone": str(sender.get("tone") or "plain, friendly and brief, like a neighbor"),
        },
        product={
            "name": str(product.get("name") or offer.get("brand") or ""),
            "description": str(product.get("description") or ""),
            "pricing": str(product.get("pricing") or ""),
            "key_benefits": [str(b) for b in (product.get("benefits") or [])][:8],
            "objection_responses": {str(k): str(v) for k, v in (product.get("objections") or {}).items()},
            "offer": {"entry": str(product.get("entry") or ""), "goal": "get_reply",
                      "booking_method": "ask_preference"},
        },
        icp={
            "industries": [str(i) for i in (offer.get("industries") or ["Local business"])],
            "company_size": str(offer.get("companySize") or "1-50 employees"),
            "titles": titles or [str(t) for t in (offer.get("titles") or DEFAULT_TITLES)],
            "geography": [str(g) for g in (offer.get("geography") or ["United States"])],
            "hiring_signals": [str(h) for h in (offer.get("hiringSignals") or [])],
        },
        channels={"email": {
            "provider": "instantly",
            # Sellbird's own Instantly mode answers replies itself; with
            # require_approval it hands every one to a person. Brain keeps the
            # authorization: the draft comes back, Brain decides and sends.
            "require_approval": False,
            "link_domains": [str(d) for d in (offer.get("linkDomains") or [])],
            "phone_numbers": [str(p) for p in (offer.get("phoneNumbers") or [])],
        }},
        compliance={
            "postal_address": str(offer.get("postalAddress") or ""),
            "opt_out_line": str(offer.get("optOutLine") or 'Reply "no thanks" and we won\'t contact you again.'),
            "do_not_contact": [str(d) for d in (offer.get("doNotContact") or [])],
        },
        writer={"humanizer": True, "site_facts": True},
    )


def _brain(state, llm: dict, offer: dict | None, calls: list):
    """Sellbird's Brain on Brain's model, with this business's own knowledge
    standing in for the trainer's product_knowledge / competitive_intel."""
    from sellbird.brain import Brain

    brain = Brain(state, transport=transport_for(llm, calls))
    knowledge = {
        "product_knowledge": str((offer or {}).get("knowledge") or ""),
        "competitive_intel": str((offer or {}).get("competition") or ""),
    }
    original = brain.load_skill

    def load_skill(name: str) -> str:
        if name in knowledge:
            return knowledge[name]
        return original(name)

    brain.load_skill = load_skill  # type: ignore[method-assign]
    return brain


async def _state(tmp: str):
    from sellbird.signals import seed_signal_catalog
    from sellbird.state import StateManager

    state = StateManager(os.path.join(tmp, "sellbird.db"))
    await state.init_db()
    await seed_signal_catalog(state)
    return state


async def _company(state, lead: dict) -> str:
    from sellbird.models.company import Company

    website = str(lead.get("website") or "")
    company = Company(
        name=str(lead.get("company") or ""),
        domain=normalize_domain(website),
        website=website,
        description=str(lead.get("description") or "")[:600],
        industry=str(lead.get("industry") or ""),
        location=str(lead.get("location") or ""),
        tech_stack=[str(t) for t in (lead.get("techStack") or [])][:10],
        signals=[s for s in (lead.get("signals") or []) if isinstance(s, dict)][:5],
    )
    cid = await state.add_company(company)
    rows = []
    for o in lead.get("observations") or []:
        if isinstance(o, dict) and o.get("signal_code"):
            rows.append({**o, "company_id": cid})
    if rows:
        try:
            await state.add_observations(rows)
        except Exception:
            pass  # a code this Sellbird does not know is a missing fact, not a failure
    return cid


async def _prospect(state, lead: dict, company_id: str):
    from sellbird.models.prospect import Prospect

    first, last = str(lead.get("firstName") or ""), str(lead.get("lastName") or "")
    prospect = Prospect(
        company_id=company_id,
        first_name=first,
        last_name=last,
        email=str(lead.get("email") or ""),
        email_status="verified" if lead.get("published", True) else "guess",
        title=str(lead.get("title") or ("" if first else "General inbox")),
        company=str(lead.get("company") or ""),
        industry=str(lead.get("industry") or ""),
        personalization_notes=str(lead.get("notes") or "")[:600],
        source="brain",
        source_url=str(lead.get("sourceUrl") or ""),
        status="new",
    )
    prospect.id = await state.add_prospect(prospect)
    return prospect


# --------------------------------------------------------------------------- #
# Research: what the business is, who decides, and how well it fits          #
# --------------------------------------------------------------------------- #

PROFILE_CODES = {
    "INCUMBENT_AGENCY", "RUNNING_GOOGLE_ADS", "RUNNING_META_ADS", "TECH_STACK", "NO_SCHEMA_MARKUP",
    "NO_ONLINE_BOOKING", "SITE_PAGE_COUNT", "BLOG_STALE", "BLOCKS_AI_CRAWLERS", "YC_BACKED", "ACCELERATOR",
    "FUNDING_ROUND", "HIRING_ROLE", "OPEN_ROLES", "DECISION_MAKER_TITLE", "LIKELY_OWNER", "CONTACT_FORM_URL",
}
_META_DESC = re.compile(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']{20,400})', re.I)


async def research(website: str, offer: dict | None = None, titles: list[str] | None = None,
                   industry: str = "") -> dict:
    from sellbird.collectors.profile import ProfileCollector
    from sellbird.fit import company_fit
    from sellbird.site_facts import site_facts
    from sellbird.startups import startup_facts

    domain = normalize_domain(website)
    if not domain:
        raise ValueError("website is not a public domain")
    contacts = (await find_contacts(website, titles=titles)).as_dict()
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        cid = await _company(state, {"website": website, "company": contacts.get("siteName") or domain})
        async with ProfileCollector(state, confirmed=set(PROFILE_CODES),
                                    role_keywords=(offer or {}).get("hiringSignals") or []) as collector:
            observations = await collector.profile_company(cid, domain)
            home = ""
            try:
                home = await collector._get(f"https://{domain}/")
            except Exception:
                home = ""
        if observations:
            await state.add_observations(observations)
        facts = await site_facts(state, cid)
        startup = await startup_facts(state, cid) or []
        tech = sorted({t.strip() for o in observations if o.get("signal_code") == "TECH_STACK"
                       for t in str(o.get("value_text") or "").split(",") if t.strip()})
        match = _META_DESC.search(home or "")
        description = re.sub(r"\s+", " ", match.group(1)).strip() if match else ""
        fit = None
        if offer is not None:
            config = build_config(offer, titles)
            people = [{"first_name": p["firstName"], "last_name": p["lastName"], "title": p["title"],
                       "email": p.get("email") or "", "email_status": "verified" if p.get("published") else "guess",
                       "status": "new"} for p in contacts["people"]]
            if contacts.get("inbox"):
                people.append({"first_name": "", "last_name": "", "title": "General inbox",
                               "email": contacts["inbox"].get("email") or "", "email_status": "verified", "status": "new"})
            score, reasons = company_fit({"domain": domain, "industry": industry},
                                         people, observations, config)
            fit = {"score": score, "reasons": reasons}
    clean_obs = [{k: o.get(k) for k in ("signal_code", "value_num", "value_text", "confidence", "evidence_url")}
                 for o in observations]
    return {**contacts, "description": description, "techStack": tech, "facts": facts + startup,
            "observations": clean_obs, "fit": fit}


# --------------------------------------------------------------------------- #
# Writing                                                                     #
# --------------------------------------------------------------------------- #

def _call_summary(calls: list) -> str:
    """Why a write produced nothing, from the model calls themselves: an HTTP
    refusal (a model name the server does not serve) and an empty answer are
    different repairs, and "no usable draft" alone named neither."""
    if not calls:
        return " (no model call was made)"
    refused = [str(c.get("status")) for c in calls if c.get("status")]
    empty = sum(1 for c in calls if not c.get("ok") and not c.get("status"))
    parts = []
    if refused:
        parts.append(f"model server answered HTTP {', '.join(sorted(set(refused)))} on {len(refused)} call(s)")
    if empty:
        parts.append(f"{empty} call(s) came back empty")
    return f" ({'; '.join(parts)} of {len(calls)})" if parts else f" ({len(calls)} call(s) answered)"


def _strip_sign_off(body: str, names: list[str]) -> str:
    """Sellbird signs with the persona's first name; Instantly's sending
    account signs instead (the sender identity is the account's own)."""
    lines = body.rstrip().split("\n")
    firsts = {n.strip().split(" ")[0].lower() for n in names if n and n.strip()}
    while lines and (not lines[-1].strip() or lines[-1].strip().lower().rstrip(",.") in firsts
                     or re.fullmatch(r"(best|thanks|cheers|regards|thank you)[,.]?", lines[-1].strip(), re.I)):
        lines.pop()
    return "\n".join(lines).strip()


async def write_first_email(offer: dict, lead: dict, llm: dict) -> dict:
    from sellbird.agents.writer import Writer, _names
    from sellbird.email_style import style_problems
    from sellbird.gate import autopilot_review
    from sellbird.humanize import humanize, humanizer_enabled

    calls: list = []
    config = build_config(offer)
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        cid = await _company(state, lead)
        prospect = await _prospect(state, lead, cid)
        brain = _brain(state, llm, offer, calls)
        writer = Writer(brain, state, config)
        writer.skills = brain.load_skills_for_agent("writer")
        writer.email_rules = str(offer.get("emailRules") or "")
        feedback = [str(f) for f in (offer.get("feedback") or [])][:8]

        async def feedback_block(_ids) -> str:
            if not feedback:
                return ""
            return ("\n\nWHAT BRAIN LEARNED FROM THIS CAMPAIGN'S REPLIES (apply it; it never overrides"
                    " the STRICT EMAIL RULES or the FACTS rule):\n" + "\n".join(f"- {f}" for f in feedback))

        writer._feedback_block = feedback_block  # type: ignore[method-assign]
        tip = await writer._has_tip_basis(prospect)
        draft = await writer._write_personal_email(prospect)
        if not draft:
            return {"ok": False, "reason": "the model wrote no usable draft" + _call_summary(calls),
                    "tipBasis": tip, "calls": calls}
        polished = (await humanize(brain, [draft], agent="writer", enabled=humanizer_enabled(config)))[0]
        kept = await writer._keep_to_rules(polished, step=1, names=_names(prospect))
        if kept is None:
            return {"ok": False, "reason": "the draft broke Sellbird's writing rules after a rewrite",
                    "tipBasis": tip, "calls": calls}
        body = _strip_sign_off(kept["body"], [config.persona.name])
        held = autopilot_review(kept["subject"], body, config, recipient=str(lead.get("email") or ""))
        return {
            "ok": not held,
            "reason": ("held: " + "; ".join(held)) if held else "",
            "subject": kept["subject"],
            "body": body,
            "problems": style_problems(kept["subject"], body, kind="cold", step=1, names=_names(prospect), shape=False),
            "tipBasis": tip,
            "calls": calls,
        }


async def write_sequence(offer: dict, sample: list[dict], llm: dict) -> dict:
    from sellbird.agents.writer import Writer

    calls: list = []
    config = build_config(offer)
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        prospects = []
        for lead in sample[:5]:
            cid = await _company(state, lead)
            prospects.append(await _prospect(state, lead, cid))
        brain = _brain(state, llm, offer, calls)
        writer = Writer(brain, state, config)
        writer.skills = brain.load_skills_for_agent("writer")
        writer.email_rules = str(offer.get("emailRules") or "")
        steps = await writer._write_sequence(prospects)
        out = [{"step": s.step, "subject": s.subject,
                "body": _strip_sign_off(s.body, [config.persona.name]), "delayDays": s.delay_days} for s in steps]
        return {"ok": bool(out), "steps": out, "calls": calls}


async def _actions(db_path: str) -> list[dict]:
    """Sellbird's own action log for this request (opt_out, escalation, ...)."""
    import aiosqlite

    async with aiosqlite.connect(db_path) as db:
        async with db.execute("SELECT action_type, details_json FROM actions ORDER BY rowid") as cur:
            rows = await cur.fetchall()
    out = []
    for kind, details in rows:
        try:
            out.append({"action_type": kind, "details": json.loads(details or "{}")})
        except ValueError:
            out.append({"action_type": kind, "details": {}})
    return out


# --------------------------------------------------------------------------- #
# Replies                                                                     #
# --------------------------------------------------------------------------- #

class _Recorder:
    """Stands in for Sellbird's Instantly client: what it would send, not sent."""

    def __init__(self):
        self.sent: list[dict] = []

    async def send_reply(self, reply_uuid: str, body: str):
        self.sent.append({"replyTo": reply_uuid, "body": body})
        return {"recorded": True}

    def __getattr__(self, name):  # any other Instantly call is refused, never made
        async def refuse(*_a, **_k):
            raise RuntimeError(f"Instantly.{name} is Brain's to call")
        return refuse


async def handle_reply(offer: dict, lead: dict, reply: dict, history: list[dict], llm: dict) -> dict:
    """Sellbird's whole reply flow on one reply; Brain receives its decision."""
    from sellbird.agents.handler import Handler
    from sellbird.config import EnvConfig
    from sellbird.models.conversation import Conversation, Message

    calls: list = []
    config = build_config(offer)
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        cid = await _company(state, lead)
        prospect = await _prospect(state, lead, cid)
        if lead.get("optedOut"):
            await state.update_prospect_status(prospect.id, "opted_out")
        # What we sent them, so a quoted footer is never read as their words.
        ours = [str(t) for t in (offer.get("sentTexts") or [])]
        thread = [Message(sender="prospect" if m.get("from") == "them" else "sellbird", content=str(m.get("text") or ""))
                  for m in history if str(m.get("text") or "").strip()]
        if thread:
            await state.add_conversation(Conversation(
                id="", prospect_id=prospect.id, campaign_id="brain", channel="email",
                thread=thread, intent="", stage=str(lead.get("stage") or "initial_outreach"),
                status="needs_human" if lead.get("withPerson") else "open"))
        brain = _brain(state, llm, offer, calls)
        handler = Handler(brain, state, config, EnvConfig())
        handler.instantly = _Recorder()
        handler.skills = brain.load_skills_for_agent("handler")

        async def our_text(_p):
            from sellbird.agents.handler import OurText
            from sellbird.config import DEFAULT_OPT_OUT_LINE, compliance_of
            compliance = compliance_of(config)
            return OurText([*ours, compliance.postal_address, compliance.opt_out_line, DEFAULT_OPT_OUT_LINE])

        handler._our_text = our_text  # type: ignore[method-assign]
        await handler._process_reply(
            str(lead.get("email") or "").lower(), str(reply.get("text") or ""), str(reply.get("id") or ""), "brain")

        convos = (await state.get_conversations_by_status("open") + await state.get_conversations_by_status("needs_human")
                  + await state.get_conversations_by_status("closed"))
        convo = next((c for c in convos if c.prospect_id == prospect.id), None)
        after = await state.get_prospect(prospect.id)
        actions = await _actions(os.path.join(tmp, "sellbird.db"))
        opt_out = next((a.get("details") for a in actions if a.get("action_type") == "opt_out"), None)
        escalations = [a.get("details") for a in actions if a.get("action_type") == "escalation"]
        answer = handler.instantly.sent[0]["body"] if handler.instantly.sent else ""
        return {
            "intent": convo.intent if convo else "",
            "stage": convo.stage if convo else "",
            "status": convo.status if convo else "",
            "prospectStatus": after.status if after else "",
            "optOut": {k: (opt_out or {}).get(k) for k in ("rule", "matched", "why")} if opt_out else None,
            "escalations": [{k: (e or {}).get(k) for k in ("reason", "reply_preview")} for e in escalations],
            "answer": answer,
            "calls": calls,
        }


# --------------------------------------------------------------------------- #
# Learning                                                                    #
# --------------------------------------------------------------------------- #

def insights(report: dict) -> list[str]:
    from sellbird.agents.analyst import Analyst

    return list(Analyst.__new__(Analyst)._generate_insights(report) or [])


async def knowledge(llm: dict, url: str = "", pages: dict | None = None, max_pages: int = 25) -> dict:
    """Sellbird's trainer over a business's own pages: product facts, ICP,
    competition and objections with answers. A business with no website gives
    its own documents as ``pages`` (name -> text); one with a site is crawled
    by Sellbird's free FallbackCrawler. Brain's model."""
    from sellbird.config import BrainConfig
    from sellbird.trainer import FallbackCrawler, Trainer

    calls: list = []
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        # Trainer() would open Sellbird's own home database and its Claude
        # brain; this one reads the given pages with Brain's model only.
        trainer = Trainer.__new__(Trainer)
        trainer.brain_config = BrainConfig()
        trainer.state = state
        trainer.brain = _brain(state, llm, None, calls)
        trainer.scraped_pages = {str(k): str(v)[:20000] for k, v in (pages or {}).items()} if pages else \
            await FallbackCrawler().crawl(url, max_pages=max_pages)
        product = await trainer._extract_product_info()
        icp = await trainer._extract_icp()
        competition = await trainer._extract_competitive_intel(product or {})
        objections = await trainer._generate_objections(product or {}, competition or {})
        return {"pages": len(trainer.scraped_pages or {}), "product": product, "icp": icp,
                "competition": competition, "objections": objections or {}, "calls": calls}


def deliverability(domain: str, dkim_selector: str = "") -> list[dict]:
    """Sellbird's DNS checks for a sending domain: MX, SPF, DMARC, DKIM and the
    domain blocklists. Free; reads public DNS only."""
    from sellbird import deliverability as d

    host = normalize_domain(domain)
    if not host:
        raise ValueError("not a public domain")
    checks = [d.check_mx(host), d.check_spf(host), d.check_dmarc(host), d.check_dkim(host, dkim_selector),
              *d.check_domain_blocklists(host)]
    return [{"name": c.name, "status": c.status, "detail": c.detail, "unknown": bool(c.unknown)} for c in checks]


async def suggest_offers(offer: dict, llm: dict) -> dict:
    """Sellbird's offer designer: free first-email offers that fit the product."""
    from sellbird.offer import suggest_offers as suggest

    calls: list = []
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        state = await _state(tmp)
        ideas = await suggest(_brain(state, llm, offer, calls), build_config(offer))
    return {"ideas": ideas or [], "calls": calls}


def as_json(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))
