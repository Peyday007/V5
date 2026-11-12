"""Brain's operator app (§106): Hermes Agent behind one authenticated call.

Brain starts every run. It sends the brief, the models to think with (capacity
Brain already has: its free-model switchboard and its RunPod GPU), the MCP door
to Brain with a credential minted for this run only, and the memory Brain kept
from the last run. This process writes a throwaway HERMES_HOME from that, runs
`hermes chat --oneshot --format stream-json`, streams progress back as NDJSON
(so the private proxy sees a live request while the agent works) and ends with
one `result` line carrying the report, the tools called and the memory the
agent left. It keeps nothing: the home directory is deleted when the run ends.

The agent's hands are Brain's operator tools and nothing else: its own toolsets
are limited to memory, skills and a task list (no shell, files, browser or web),
and the Brain MCP server is filtered to the operator tools by name.

Standard library only, so the image is the published Hermes image plus this file.
"""
from __future__ import annotations

import hmac
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERMES = os.environ.get("HERMES_BIN", "hermes")
KEY = os.environ.get("BRAIN_OPERATOR_KEY", "")
PORT = int(os.environ.get("PORT", "8080"))
MEMORY_MAX_ENTRIES = 60
MEMORY_MAX_BYTES = 24_000
LOCK = threading.Lock()


def yaml_str(value: str) -> str:
    """A YAML scalar that cannot be read as anything but this string."""
    return json.dumps(value)


def build_config(body: dict) -> str:
    """config.yaml for one run: the primary model, the rest as fallbacks, and Brain's MCP door."""
    models = body["models"]
    primary = models[0]
    mcp = body["mcp"]
    lines = [
        # The schema version of the pinned image (v0.23.1): written current, so no
        # migration rewrites it (a migration seeds a keyless credential pool for the endpoint).
        "_config_version: 53",
        "model:",
        "  provider: custom",
        f"  default: {yaml_str(primary['model'])}",
        f"  base_url: {yaml_str(primary['baseUrl'])}",
        "  key_env: BRAIN_OPERATOR_MODEL_KEY",
    ]
    if primary.get("contextLength"):
        lines.append(f"  context_length: {int(primary['contextLength'])}")
    if len(models) > 1:
        lines.append("fallback_providers:")
        for index, model in enumerate(models[1:]):
            lines += [
                "  - provider: custom",
                f"    model: {yaml_str(model['model'])}",
                f"    base_url: {yaml_str(model['baseUrl'])}",
            ]
            if model.get("apiKey"):
                lines.append(f"    key_env: BRAIN_OPERATOR_FALLBACK_KEY_{index}")
    lines += [
        # Every Brain tool eager: a small model chooses better among eight named
        # tools than through a search bridge.
        "tools:",
        "  tool_search:",
        "    enabled: off",
        "agent:",
        f"  run_budget_seconds: {int(body.get('budgetSeconds', 1200))}",
        "memory:",
        "  memory_enabled: true",
        "mcp_servers:",
        "  brain:",
        f"    url: {yaml_str(mcp['url'])}",
        "    headers:",
        "      Authorization: \"Bearer ${BRAIN_OPERATOR_MCP_TOKEN}\"",
        "    timeout: 180",
        "    connect_timeout: 60",
        "    tools:",
        "      include:",
    ]
    lines += [f"        - {yaml_str(name)}" for name in mcp["tools"]]
    return "\n".join(lines) + "\n"


def safe_name(name: str) -> bool:
    parts = name.split("/")
    if ".." in parts or name.startswith("/"):
        return False
    if len(parts) == 2 and parts[0] == "memories" and parts[1].endswith(".md"):
        return True
    return len(parts) == 3 and parts[0] == "skills" and parts[2] == "SKILL.md"


def write_memory(home: Path, memory: dict) -> None:
    for name, text in list(memory.items())[:MEMORY_MAX_ENTRIES]:
        if not isinstance(text, str) or not safe_name(name):
            continue
        path = home / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text[:MEMORY_MAX_BYTES], encoding="utf-8")


def read_memory(home: Path) -> dict:
    out: dict[str, str] = {}
    for path in sorted((home / "memories").glob("*.md")) + sorted((home / "skills").glob("*/SKILL.md")):
        name = path.relative_to(home).as_posix()
        if safe_name(name) and len(out) < MEMORY_MAX_ENTRIES:
            out[name] = path.read_text(encoding="utf-8", errors="replace")[:MEMORY_MAX_BYTES]
    return out


def command(body: dict, prompt_file: Path) -> list[str]:
    # The model, its endpoint and its key come from config.yaml only: Hermes trusts
    # `model.key_env` for the configured base_url, never for one given on the command line.
    toolsets = list(body.get("toolsets") or []) + ["mcp-brain"]
    return [
        HERMES, "chat",
        "--query-file", str(prompt_file),
        "--oneshot", "--format", "stream-json",
        "-t", ",".join(toolsets),
        "--max-turns", str(int(body.get("maxTurns", 40))),
        "--source", "tool",
    ]


def translate(event: dict) -> dict | None:
    """Hermes' stream-json event → the line Brain reads. Tool inputs and outputs are not forwarded."""
    kind = event.get("type")
    if kind == "tool_result":
        ok = not event.get("is_error", False)
        out = {"type": "tool", "tool": str(event.get("name", ""))[:120], "ok": ok}
        if not ok:
            # The refusal's first line, so a failed run names why. Brain's errors
            # carry no payload or identifier the caller did not hold (invariant 30).
            out["error"] = str(event.get("output", "")).strip().splitlines()[0][:300] if event.get("output") else ""
        return out
    if kind == "system":
        return {"type": "system", "model": event.get("model")}
    return None


def preflight(mcp: dict) -> str:
    """Can this app reach Brain's MCP door with the run's credential? Said in the result, so a failed run names why."""
    import urllib.request
    payload = json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "brain-operator", "version": "1"}}}).encode()
    request = urllib.request.Request(mcp["url"], data=payload, method="POST", headers={
        "authorization": f"Bearer {mcp['token']}", "content-type": "application/json",
        "accept": "application/json, text/event-stream"})
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return f"HTTP {response.status} in {int((time.time() - started) * 1000)} ms"
    except Exception as error:  # noqa: BLE001 — the reason is the answer
        return f"unreachable after {int((time.time() - started) * 1000)} ms: {str(error)[:200]}"


def run_operator(body: dict, emit) -> dict:
    home = Path(tempfile.mkdtemp(prefix="operator-"))
    reached = preflight(body["mcp"])
    emit({"type": "preflight", "mcp": reached})
    try:
        (home / "config.yaml").write_text(build_config(body), encoding="utf-8")
        write_memory(home, body.get("memory") or {})
        prompt = home / "prompt.txt"
        prompt.write_text(body["prompt"], encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "BRAIN_OPERATOR_KEY"}
        env["HERMES_HOME"] = str(home)
        env["HERMES_WRITE_SAFE_ROOT"] = str(home)
        # Hermes resolves `key_env` and `${VAR}` from its home's .env; the file
        # lives only as long as this run's home directory.
        secrets = {
            "BRAIN_OPERATOR_MCP_TOKEN": body["mcp"]["token"],
            # vLLM and the switchboard both want a bearer; a keyless endpoint gets a placeholder.
            "BRAIN_OPERATOR_MODEL_KEY": body["models"][0].get("apiKey") or "none",
        }
        for index, model in enumerate(body["models"][1:]):
            if model.get("apiKey"):
                secrets[f"BRAIN_OPERATOR_FALLBACK_KEY_{index}"] = model["apiKey"]
        env.update(secrets)
        dotenv = home / ".env"
        dotenv.write_text("".join(f"{k}={v}\n" for k, v in secrets.items()), encoding="utf-8")
        dotenv.chmod(0o600)
        proc = subprocess.Popen(
            command(body, prompt), cwd=str(home), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        final = None
        error = None
        model = body["models"][0]["model"]
        tools: list[dict] = []
        deadline = time.time() + int(body.get("budgetSeconds", 1200)) + 180
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "result":
                final = event.get("text")
                if event.get("error") or event.get("exit_code", 0) not in (0, None):
                    error = str(event.get("error") or f"exit code {event.get('exit_code')}")[:500]
                continue
            out = translate(event)
            if out:
                if out["type"] == "system" and out.get("model"):
                    model = out["model"]
                if out["type"] == "tool":
                    tools.append(out)
                emit(out)
            if time.time() > deadline:
                proc.kill()
                error = "the run exceeded its budget"
                break
        proc.wait(timeout=60)
        stderr = proc.stderr.read() if proc.stderr else ""
        if final is None and error is None:
            error = f"hermes exited {proc.returncode} without a result: {stderr[-400:]}"
        return {"type": "result", "final": final, "error": error, "model": model, "memory": read_memory(home), "tools": len(tools), "preflight": reached}
    finally:
        shutil.rmtree(home, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # one line per request, never a body
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}", flush=True)

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("authorization", "")
        given = header[7:] if header.startswith("Bearer ") else ""
        return bool(KEY) and hmac.compare_digest(given.encode(), KEY.encode())

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json(200, {"ok": True, "agent": "hermes-agent"})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        # One refusal for every failure before the body is read: absent and forbidden look alike.
        if self.path != "/v1/operator/run" or not self._authorized():
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(min(length, 2_000_000)))
            assert isinstance(body.get("prompt"), str) and body.get("models") and body.get("mcp", {}).get("token")
        except Exception:  # noqa: BLE001 — any malformed body is the same answer
            self._json(400, {"error": "a run needs prompt, models and mcp"})
            return
        if not LOCK.acquire(blocking=False):
            self._json(409, {"error": "a run is already in progress"})
            return
        try:
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.end_headers()
            write_lock = threading.Lock()

            def emit(obj: dict) -> None:
                with write_lock:
                    self.wfile.write((json.dumps(obj) + "\n").encode())
                    self.wfile.flush()

            stop = threading.Event()

            def heartbeat() -> None:
                while not stop.wait(20):
                    try:
                        emit({"type": "heartbeat", "at": int(time.time())})
                    except OSError:
                        return

            beat = threading.Thread(target=heartbeat, daemon=True)
            beat.start()
            try:
                result = run_operator(body, emit)
            except Exception as error:  # noqa: BLE001
                result = {"type": "result", "final": None, "error": f"operator failed: {error}"[:500], "memory": {}}
            stop.set()
            emit(result)
        finally:
            LOCK.release()


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main() -> None:
    if not KEY:
        raise SystemExit("BRAIN_OPERATOR_KEY is not set; refusing to serve an unauthenticated operator.")
    try:
        server: ThreadingHTTPServer = DualStackServer(("::", PORT), Handler)
    except OSError:  # a host without IPv6; Fly's private network has it
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
        server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
