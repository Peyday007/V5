"""Who decides at a business, and where they publish an address — Sellbird's own code.

Brain owns the prospect, the campaign and every decision about sending. This
module only asks Sellbird's Scout the questions it already answers well, with
no model call and no sending:

  * which people the business's own pages name, likeliest decision maker first
    (`Scout._scrape_team_page` -> `collectors.people.find_people`);
  * each named person's address, honestly tagged (`Scout._resolve_email`);
  * the business's own general inbox, read from its pages, never guessed
    (`Scout._find_inbox_address`).

What this adds is one flag Sellbird keeps internally and Brain needs to see:
`published` — the exact address appears on the business's own pages. Without a
paid verifier (and with port 25 closed on cloud hosts) Sellbird can only call a
published address a "guess"; Brain sends only to published addresses whose
domain has a mail server, which it checks itself.

Every Scout instance is per request, with its own throwaway state database, so
nothing one business teaches leaks into the next request and nothing persists
in this container: Brain records the result.
"""
from __future__ import annotations

import asyncio
import os
import re
import tempfile
from dataclasses import dataclass, field

# Owners and the people who run a small business: the Neighbor Card's buyer.
DEFAULT_TITLES = [
    "Owner", "Co-Owner", "Founder", "Co-Founder", "President", "CEO", "Principal",
    "Managing Partner", "Partner", "General Manager", "Office Manager", "Practice Manager",
    "Manager", "Director", "Broker",
]

# A host name with a lettered top-level label: never an IP literal or a bare name.
_DOMAIN = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*[a-z]$")


def normalize_domain(website: str) -> str:
    host = re.sub(r"^[a-z]+://", "", (website or "").strip().lower()).split("/")[0].split(":")[0]
    host = host.removeprefix("www.")
    return host if _DOMAIN.match(host) else ""


@dataclass
class ContactResult:
    domain: str
    reachable: bool = True
    challenged: bool = False
    site_name: str = ""
    pages_read: int = 0
    people: list[dict] = field(default_factory=list)
    inbox: dict | None = None
    published: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "domain": self.domain,
            "reachable": self.reachable,
            "challenged": self.challenged,
            "siteName": self.site_name,
            "pagesRead": self.pages_read,
            "people": self.people,
            "inbox": self.inbox,
            "publishedAddresses": self.published,
        }


def _scout(db_path: str, titles: list[str]):
    # Imported here so the service starts (and /healthz answers) even if a
    # Sellbird import were broken; the request then fails with the reason.
    from sellbird.agents.scout import Scout
    from sellbird.config import EnvConfig, SellbirdConfig
    from sellbird.state import StateManager

    # Persona and product are required by Sellbird's schema and read only by
    # its writer and reply handler, which Brain never runs here.
    config = SellbirdConfig(
        persona={"name": "Brain", "company": "Brain", "role": "research", "email": "", "linkedin": "", "tone": "plain"},
        product={"name": "Brain", "description": "contact research", "pricing": "", "key_benefits": [], "objection_responses": {}},
        icp={
            "industries": ["Local business"],
            "company_size": "1-20 employees",
            "titles": titles,
            "geography": ["United States"],
        },
    )
    state = StateManager(db_path)
    # No model: Scout's site reading never calls one; Brain is the only thinker.
    return Scout(brain=None, state=state, config=config, env=EnvConfig()), state  # type: ignore[arg-type]


async def find_contacts(website: str, *, titles: list[str] | None = None, max_people: int = 2) -> ContactResult:
    domain = normalize_domain(website)
    if not domain:
        raise ValueError("website is not a public domain")
    result = ContactResult(domain=domain)
    with tempfile.TemporaryDirectory(prefix="sellbird-") as tmp:
        scout, state = _scout(os.path.join(tmp, "sellbird.db"), titles or DEFAULT_TITLES)
        await state.init_db()
        members = await scout._scrape_team_page(domain)
        site = scout._site_reads.get(scout._host(domain), {})
        result.pages_read = len(site.get("pages", []))
        result.challenged = bool(site.get("challenged"))
        result.reachable = bool(site.get("base"))
        if site.get("pages"):
            from sellbird.collectors.discover import site_name_from_html
            result.site_name = site_name_from_html(site["pages"][0][1], domain)
        published = [a.lower() for a in site.get("addresses", [])]
        result.published = published[:20]

        ranked = sorted(members, key=lambda m: -(m.get("rank") or 0))
        for member in ranked:
            if len(result.people) >= max_people:
                break
            title = member.get("title", "")
            owner = bool(member.get("owner"))
            if not (scout._title_matches_icp(title) or (owner and scout._icp_wants_owner())):
                continue
            first, last = member.get("first_name", ""), member.get("last_name", "")
            if not (first and last):
                continue
            email, status = await scout._resolve_email(first, last, domain)
            result.people.append({
                "firstName": first,
                "lastName": last,
                "title": title or ("Owner" if owner else ""),
                "owner": owner,
                "email": email or None,
                "status": status,
                "published": bool(email) and email.lower() in published,
                "evidenceUrl": member.get("evidence_url") or f"https://{domain}",
            })

        if result.reachable:
            inbox = await scout._find_inbox_address(domain)
            if inbox:
                result.inbox = {"email": inbox, "published": True}
    return result


def run(website: str, **kwargs) -> dict:
    """Synchronous helper for scripts and tests."""
    return asyncio.run(find_contacts(website, **kwargs)).as_dict()
