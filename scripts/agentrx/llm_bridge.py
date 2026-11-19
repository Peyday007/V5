#!/usr/bin/env python3
"""AgentRx's model, on capacity Brain already has (§106, §108).

AgentRx (microsoft/AgentRx) calls its model through a "copilot" endpoint: it
runs one binary per call, pipes the prompt to its stdin and reads the answer
from its stdout (agentrx/llm_clients/copilot_cli.py). Pointing
AGENT_VERIFY_COPILOT_BIN at this file sends every one of those calls to an
OpenAI-compatible endpoint instead. That endpoint is the free-provider
switchboard that the free lane and Hermes already use: no new provider, no new
key, no paid frontier API. AgentRx itself is not modified.

Environment:
  AGENTRX_LLM_URL    base URL ending in /v1 (the switchboard)
  AGENTRX_LLM_KEY    its endpoint key
  AGENTRX_LLM_MODEL  the route (default auto/best-coding, the operator's)
  AGENTRX_USAGE_LOG  optional JSONL file; one line per call (tokens, seconds, status)

Standard library only, so it runs in AgentRx's isolated environment unchanged.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

VERSION = "brain-agentrx-bridge 1"
# The switchboard's free providers cap a request near 64K tokens (operator.ts);
# a prompt larger than this is refused here rather than truncated, because a
# truncated trajectory would be diagnosed as if it were the whole one.
MAX_PROMPT_CHARS = 200_000
RETRYABLE = {408, 409, 425, 429, 500, 502, 503, 504}


def log_usage(entry: dict) -> None:
    path = os.environ.get("AGENTRX_USAGE_LOG")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def call(prompt: str) -> str:
    url = os.environ.get("AGENTRX_LLM_URL", "").rstrip("/")
    key = os.environ.get("AGENTRX_LLM_KEY", "")
    model = os.environ.get("AGENTRX_LLM_MODEL", "auto/best-coding")
    if not url:
        print("AGENTRX_LLM_URL is not set", file=sys.stderr)
        return ""
    if len(prompt) > MAX_PROMPT_CHARS:
        print(f"prompt of {len(prompt)} chars exceeds {MAX_PROMPT_CHARS}; refused", file=sys.stderr)
        log_usage({"status": "REFUSED_TOO_LARGE", "prompt_chars": len(prompt), "model": model})
        return ""
    body = json.dumps({
        "model": model,
        "max_tokens": 4000,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    delay = 5.0
    for attempt in range(1, 6):
        start = time.time()
        req = urllib.request.Request(
            f"{url}/chat/completions",
            data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
            method="POST",
        )
        status = 0
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                status = resp.status
                data = json.loads(resp.read().decode("utf-8"))
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            usage = data.get("usage") or {}
            log_usage({
                "status": status, "attempt": attempt, "model": data.get("model") or model,
                "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
                "seconds": round(time.time() - start, 2), "prompt_chars": len(prompt),
            })
            if text.strip():
                return text.strip()
            print(f"empty answer (attempt {attempt})", file=sys.stderr)
        except urllib.error.HTTPError as e:
            status = e.code
            detail = e.read().decode("utf-8", "replace")[:300]
            log_usage({"status": status, "attempt": attempt, "model": model, "seconds": round(time.time() - start, 2), "error": detail})
            print(f"HTTP {status} (attempt {attempt}): {detail}", file=sys.stderr)
            if status not in RETRYABLE:
                return ""
        except Exception as e:  # timeouts, resets
            log_usage({"status": "ERROR", "attempt": attempt, "model": model, "seconds": round(time.time() - start, 2), "error": str(e)[:300]})
            print(f"error (attempt {attempt}): {e}", file=sys.stderr)
        time.sleep(delay)
        delay = min(delay * 2, 60.0)
    return ""


def main() -> int:
    if "--version" in sys.argv[1:]:
        print(VERSION)
        return 0
    prompt = sys.stdin.read()
    answer = call(prompt)
    if not answer:
        return 1
    sys.stdout.write(answer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
