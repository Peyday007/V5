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
# Finished results by run id, so a Brain that restarted mid-run can collect one.
RESULTS: dict[str, dict] = {}
RESULTS_KEPT = 8
# Past its budget a run gets this long to finish its last call before it is stopped.
BUDGET_GRACE_SECONDS = 180
# The machine stops itself, never mid-run (§106). Fly's proxy autostop counts
# connections, and a Brain that restarted mid-run drops the only one: at 20:56
# on 2026-11-12 it stopped this machine under opr_59db70fd and the run and its
# result were lost. So the app is deployed with autostop off and exits when no
# run holds LOCK and nothing has asked for anything for IDLE_STOP_SECONDS —
# long enough for a restarted Brain to collect a finished result.
IDLE_STOP_SECONDS = int(os.environ.get("BRAIN_OPERATOR_IDLE_STOP_SECONDS", "1200"))
ACTIVITY = {"at": time.monotonic()}


def touch() -> None:
    ACTIVITY["at"] = time.monotonic()


def idle_for(now: float | None = None) -> float | None:
    """Seconds idle, or None while a run holds the lock."""
    if LOCK.locked():
        return None
    return (time.monotonic() if now is None else now) - ACTIVITY["at"]


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
        # The free switchboard shares its credentials with Brain's research lane and answers
        # 429 while they cool down (opr_7af304c3): wait it out rather than give up after 3.
        "  api_max_retries: 8",
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
        # Production, 2026-11-13 (opr_681f7877 ran 36 min, opr_fc22b38c 52 min,
        # against a 23 min limit): the deadline was checked only when Hermes
        # printed a line, so a silent Hermes was never stopped, and a run past
        # Brain's 45 min stale bound could not be collected after a restart.
        # stderr was read only at the end, so a chatty Hermes filled the pipe
        # and blocked — silent. stderr is drained as it comes, and the deadline
        # is a timer that kills the process whether or not it is talking.
        stderr_tail: list[str] = []

        def drain() -> None:
            assert proc.stderr is not None
            for err_line in proc.stderr:
                stderr_tail.append(err_line)
                del stderr_tail[:-40]

        drainer = threading.Thread(target=drain, daemon=True)
        drainer.start()
        overran = threading.Event()

        def overrun() -> None:
            overran.set()
            proc.kill()

        killer = threading.Timer(int(body.get("budgetSeconds", 1200)) + BUDGET_GRACE_SECONDS, overrun)
        killer.daemon = True
        killer.start()
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
        killer.cancel()
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        drainer.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()
        if overran.is_set():
            error = "the run exceeded its budget"
        stderr = "".join(stderr_tail)
        if final is None and error is None:
            error = f"hermes exited {proc.returncode} without a result: {stderr[-400:]}"
        return {"type": "result", "final": final, "error": error, "model": model, "memory": read_memory(home), "tools": len(tools), "toolEvents": tools, "preflight": reached}
    finally:
        shutil.rmtree(home, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # one line per request, never a body
        touch()
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
        prefix = "/v1/operator/runs/"
        if self.path.startswith(prefix) and self._authorized():
            result = RESULTS.get(self.path[len(prefix):])
            if result is not None:
                self._json(200, result)
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

            gone = threading.Event()

            def emit(obj: dict) -> None:
                # A Brain that restarted is not a reason to abandon the run: keep going, keep the result.
                if gone.is_set():
                    return
                try:
                    with write_lock:
                        self.wfile.write((json.dumps(obj) + "\n").encode())
                        self.wfile.flush()
                except OSError:
                    gone.set()

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
            run_id = str(body.get("runId") or "")
            if run_id:
                RESULTS[run_id] = result
                while len(RESULTS) > RESULTS_KEPT:
                    RESULTS.pop(next(iter(RESULTS)))
            emit(result)
        finally:
            touch()
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

    def stop_when_idle() -> None:
        while True:
            time.sleep(30)
            idle = idle_for()
            if idle is not None and idle > IDLE_STOP_SECONDS:
                print(f"idle {int(idle)}s with no run in progress; stopping the machine", flush=True)
                server.shutdown()
                return

    threading.Thread(target=stop_when_idle, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
