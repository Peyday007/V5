"""Sellbird's sales mind as Brain calls it (sales.py): its own writer, reply
handler and analyst on an OpenAI-compatible model, with nothing sent."""
from __future__ import annotations

import asyncio
import http.server
import json
import threading

import pytest
from fastapi.testclient import TestClient

from brain_agents import app as app_mod
from brain_agents import sales

KEY = "k" * 40
OFFER = {
    "brand": "The Neighbor Card",
    "sender": {"name": "Peyton Rosser"},
    "product": {"name": "The Neighbor Card", "description": "A postcard of local offers mailed to 4,944 homes",
                "pricing": "$295 a spot", "benefits": ["one business per category"],
                "entry": "the route map and one-page rate card"},
    "postalAddress": "1326 Selden St, Detroit, MI 48201",
    "phoneNumbers": ["313-671-6425"],
}


class _Model(http.server.BaseHTTPRequestHandler):
    """A scripted OpenAI-compatible model; it records every prompt it saw."""
    prompts: list[str] = []
    draft = {"subject": "your january spot", "body": "Saw you serve Camp Hill families. Want the route map and rate card?"}

    def log_message(self, *_a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert body["messages"][0]["content"] == "/no_think"
        prompt = body["messages"][-1]["content"]
        _Model.prompts.append(prompt)
        if "Classify this email reply" in prompt:
            out = "interested"
        elif "Write ONE cold email" in prompt:
            out = json.dumps(_Model.draft)
        elif "Write a reply that" in prompt:
            out = "Thanks. I will send the route map and rate card in my next note."
        else:
            out = "{}"
        # Qwen3 may still think out loud; sales.py removes it before Sellbird reads the answer.
        data = json.dumps({"choices": [{"message": {"content": "<think>{not json}</think>" + out}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module")
def llm():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {"baseUrl": f"http://127.0.0.1:{server.server_address[1]}/v1", "model": "scripted"}
    server.shutdown()


def run(coro):
    return asyncio.run(coro)


def test_the_writer_returns_one_grounded_draft_signed_by_nobody(llm):
    _Model.prompts.clear()
    out = run(sales.write_first_email(OFFER, {"email": "info@harbor.example", "company": "Harbor Pizza",
                                              "website": "https://harbor.example", "description": "Family pizza in Camp Hill"}, llm))
    assert out["ok"] is True and out["subject"] == "your january spot"
    assert not out["body"].rstrip().endswith("Peyton"), "the sending account signs, not Sellbird's persona"
    writer_prompt = next(p for p in _Model.prompts if "Write ONE cold email" in p)
    assert "Family pizza in Camp Hill" in writer_prompt and "<untrusted" in writer_prompt
    assert "the route map and one-page rate card" in writer_prompt


def test_a_draft_pointing_somewhere_else_is_held(llm, monkeypatch):
    monkeypatch.setattr(_Model, "draft", {"subject": "quick idea", "body": "See evil-example.com for the map. Want it?"})
    out = run(sales.write_first_email(OFFER, {"email": "info@harbor.example", "company": "Harbor Pizza"}, llm))
    assert out["ok"] is False and "held" in out["reason"]


def test_an_opt_out_is_honoured_by_rule_without_asking_the_model(llm):
    _Model.prompts.clear()
    out = run(sales.handle_reply(OFFER, {"email": "info@harbor.example", "company": "Harbor Pizza"},
                                 {"id": "e1", "text": "Please remove me from your list."}, [], llm))
    assert out["intent"] == "unsubscribe" and out["prospectStatus"] == "opted_out"
    assert out["optOut"]["rule"] and out["answer"] == ""
    assert not any("Classify this email reply" in p for p in _Model.prompts)


def test_a_legal_threat_goes_to_a_person_with_no_answer(llm):
    out = run(sales.handle_reply(OFFER, {"email": "info@harbor.example", "company": "Harbor Pizza"},
                                 {"id": "e2", "text": "This is spam. My attorney will hear about it."}, [], llm))
    assert out["intent"] == "escalate" and out["answer"] == "" and out["status"] == "needs_human"


def test_an_interested_reply_gets_a_drafted_answer_that_is_recorded_not_sent(llm):
    out = run(sales.handle_reply(OFFER, {"email": "info@harbor.example", "company": "Harbor Pizza"},
                                 {"id": "e3", "text": "Sure, send the route map."},
                                 [{"from": "us", "text": "A January postcard to 4,944 homes..."}], llm))
    assert out["intent"] == "interested" and out["stage"] == "engaged"
    assert "route map" in out["answer"]


def test_any_other_instantly_call_is_refused_rather_than_made():
    with pytest.raises(RuntimeError, match="Brain's to call"):
        run(sales._Recorder().add_leads("x"))


def test_the_analyst_reads_brain_figures():
    report = {"pipeline": {"total": 200, "contacted": 200, "replied": 2},
              "campaigns": [], "intents": {"interested": 1, "unsubscribe": 1}, "stages": {}}
    assert isinstance(sales.insights(report), list)


@pytest.mark.parametrize("path,body", [
    ("/v1/sellbird/research", {"website": "example.com"}),
    ("/v1/sellbird/write", {"offer": {}, "lead": {}, "llm": {"baseUrl": "http://x.test/v1", "model": "m"}}),
    ("/v1/sellbird/sequence", {"offer": {}, "sample": [{}], "llm": {"baseUrl": "http://x.test/v1", "model": "m"}}),
    ("/v1/sellbird/reply", {"offer": {}, "lead": {}, "reply": {}, "llm": {"baseUrl": "http://x.test/v1", "model": "m"}}),
    ("/v1/sellbird/insights", {"report": {}}),
    ("/v1/sellbird/knowledge", {"llm": {"baseUrl": "http://x.test/v1", "model": "m"}, "url": "example.com"}),
    ("/v1/sellbird/offers", {"offer": {}, "llm": {"baseUrl": "http://x.test/v1", "model": "m"}}),
    ("/v1/sellbird/deliverability", {"domain": "example.com"}),
])
def test_every_sales_route_refuses_a_wrong_key(monkeypatch, path, body):
    monkeypatch.setenv("BRAIN_AGENTS_KEY", KEY)
    answer = TestClient(app_mod.app).post(path, json=body, headers={"authorization": "Bearer wrong"})
    assert answer.status_code == 401 and answer.json() == {"detail": "unauthorized"}
