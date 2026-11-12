"""Focused tests of the agents service: the interface Brain calls and the
guards that make it safe. Run in the image before it is pushed (agents.yml)."""
from __future__ import annotations

import asyncio
import functools
import http.server
import os
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from brain_agents import app as app_mod
from brain_agents import contacts as contacts_mod
from brain_agents.browse import READ_ONLY_EXCLUDED, chromium_path, find_contact, verify_on_page

KEY = "k" * 40


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("BRAIN_AGENTS_KEY", KEY)
    return TestClient(app_mod.app)


def test_healthz_answers_without_a_key_and_names_both_agents(client):
    body = client.get("/healthz").json()
    assert body["ok"] is True and body["keyConfigured"] is True
    assert body["agents"]["sellbird"] != "missing"
    assert body["agents"]["browser-use"] == "0.13.14"


@pytest.mark.parametrize("header", [None, "Bearer wrong", f"Bearer {KEY[:-1]}", "Bearer "])
def test_every_v1_call_refuses_a_missing_or_wrong_key_the_same_way(client, header):
    headers = {"authorization": header} if header else {}
    for path, body in (("/v1/sellbird/contacts", {"website": "example.com"}),
                       ("/v1/browser/contact", {"website": "example.com", "llm": {"baseUrl": "http://x.test/v1", "model": "m"}})):
        answer = client.post(path, json=body, headers=headers)
        assert answer.status_code == 401
        assert answer.json() == {"detail": "unauthorized"}


def test_no_configured_key_refuses_everything(monkeypatch):
    monkeypatch.delenv("BRAIN_AGENTS_KEY", raising=False)
    answer = TestClient(app_mod.app).post("/v1/sellbird/contacts", json={"website": "example.com"}, headers={"authorization": "Bearer "})
    assert answer.status_code == 401


def test_a_private_or_malformed_website_is_refused(client):
    for website in ("localhost", "http://10.0.0.1/", "not a site"):
        answer = client.post("/v1/sellbird/contacts", json={"website": website}, headers={"authorization": f"Bearer {KEY}"})
        assert answer.status_code == 400


def test_normalize_domain():
    assert contacts_mod.normalize_domain("https://www.Example-Plumbing.com/contact") == "example-plumbing.com"
    assert contacts_mod.normalize_domain("example.com:8443") == "example.com"
    assert contacts_mod.normalize_domain("") == ""


HOME = """<html><head><title>Harbor Plumbing</title></head><body>
<nav><a href="/about">About</a><a href="/contact">Contact</a></nav></body></html>"""
ABOUT = """<html><body><h2>Our team</h2>
<p>Harbor Plumbing is owned and operated by Gary Pruitt.</p>
<p>Gary Pruitt<br>Owner</p><p>Email gary@harborplumbing.com</p></body></html>"""
CONTACT = """<html><body><a href="mailto:office@harborplumbing.com">office@harborplumbing.com</a></body></html>"""


def test_sellbird_contacts_reads_people_and_marks_published_addresses(client, monkeypatch):
    pages = {
        "https://harborplumbing.com": HOME,
        "https://harborplumbing.com/about": ABOUT,
        "https://harborplumbing.com/contact": CONTACT,
    }

    async def fake_fetch(self, url, *args, **kwargs):
        text = pages.get(url.rstrip("/")) if url.rstrip("/") in pages else None
        return SimpleNamespace(text=text, url=url, status_code=200) if text else None

    async def fake_resolve(self, first, last, domain):
        return f"{first}@{domain}".lower(), "guess"

    from sellbird.agents.scout import Scout
    monkeypatch.setattr(Scout, "_fetch", fake_fetch)
    monkeypatch.setattr(Scout, "_resolve_email", fake_resolve)
    body = client.post("/v1/sellbird/contacts", json={"website": "https://harborplumbing.com"},
                       headers={"authorization": f"Bearer {KEY}"}).json()
    assert body["reachable"] is True and body["pagesRead"] >= 2
    owner = body["people"][0]
    assert (owner["firstName"], owner["lastName"]) == ("Gary", "Pruitt")
    assert owner["email"] == "gary@harborplumbing.com" and owner["published"] is True
    assert "gary@harborplumbing.com" in body["publishedAddresses"]
    assert body["inbox"] == {"email": "office@harborplumbing.com", "published": True}


def test_a_guessed_address_is_never_marked_published(monkeypatch):
    async def fake_fetch(self, url, *args, **kwargs):
        if url.rstrip("/") == "https://harborplumbing.com":
            return SimpleNamespace(text=HOME.replace("</body>", "<p>Owned and operated by Gary Pruitt, Owner.</p></body>"), url=url, status_code=200)
        return None

    async def fake_resolve(self, first, last, domain):
        return f"{first}.{last}@{domain}".lower(), "guess"

    from sellbird.agents.scout import Scout
    monkeypatch.setattr(Scout, "_fetch", fake_fetch)
    monkeypatch.setattr(Scout, "_resolve_email", fake_resolve)
    result = asyncio.run(contacts_mod.find_contacts("harborplumbing.com")).as_dict()
    assert result["people"] and result["people"][0]["published"] is False
    assert result["inbox"] is None


def test_the_browser_agent_cannot_type_run_script_or_search():
    for action in ("input", "send_keys", "upload_file", "select_dropdown", "evaluate", "search"):
        assert action in READ_ONLY_EXCLUDED


def test_verify_on_page_decodes_entities_and_ignores_case():
    assert verify_on_page("office@x.com", '<a href="mailto:office&#64;x.com">Office&#64;X.com</a>')
    assert not verify_on_page("owner@x.com", "<p>office@x.com</p>")
    assert not verify_on_page("", "<p>office@x.com</p>")


class _ScriptedModel:
    """Stands in for the LLM: answers 'done' with a fixed address."""

    model = "scripted"
    _verified_api_keys = True

    def __init__(self, email: str, source: str):
        self.email, self.source = email, source

    provider = name = model_name = property(lambda self: "scripted")

    async def ainvoke(self, messages, output_format=None, **kwargs):
        from browser_use.llm.views import ChatInvokeCompletion
        if output_format is None:
            return ChatInvokeCompletion(completion="ok", usage=None)
        done = {"done": {"success": True, "data": {"email": self.email, "source_url": self.source}}}
        action = {"evaluation_previous_goal": "", "memory": "", "next_goal": "", "action": [done]}
        return ChatInvokeCompletion(completion=output_format.model_validate(action), usage=None)


@pytest.mark.skipif(chromium_path() is None, reason="no Chromium in this environment")
def test_browser_task_returns_only_an_address_found_on_the_cited_page(tmp_path):
    (tmp_path / "index.html").write_text('<a href="/contact.html">Contact</a>')
    (tmp_path / "contact.html").write_text('<a href="mailto:office&#64;localhost.test">write</a>')
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://localhost:{server.server_address[1]}"
    try:
        real = asyncio.run(find_contact("localhost", base + "/", {}, model=_ScriptedModel("office@localhost.test", base + "/contact.html"), max_steps=3, timeout_s=120))
        invented = asyncio.run(find_contact("localhost", base + "/", {}, model=_ScriptedModel("owner@localhost.test", base + "/contact.html"), max_steps=3, timeout_s=120))
    finally:
        server.shutdown()
    assert real["status"] == "VERIFIED" and real["verified"] is True
    assert invented["status"] == "UNVERIFIED" and invented["verified"] is False
