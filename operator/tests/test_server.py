"""The operator app's own rules, run inside the image that ships (agents.yml operator-deploy)."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

BODY = {
    "prompt": "run",
    "models": [
        {"baseUrl": "http://northline-cheap.flycast/v1", "model": "free-combo", "apiKey": "k1"},
        {"baseUrl": "https://pod-8000.proxy.runpod.net/v1", "model": "Qwen/Qwen3-4B", "apiKey": "k2"},
    ],
    "mcp": {"url": "http://northline-brain.internal:8080/mcp", "token": "brnw_x.y", "tools": ["brain_operator_goals"]},
    "toolsets": ["memory", "skills", "todo"],
    "maxTurns": 40,
    "budgetSeconds": 1200,
}


class Config(unittest.TestCase):
    def test_no_secret_is_written_into_config(self):
        text = server.build_config(BODY)
        for secret in ("k1", "k2", "brnw_x.y"):
            self.assertNotIn(secret, text)
        self.assertIn("key_env: BRAIN_OPERATOR_MODEL_KEY", text)
        self.assertIn("${BRAIN_OPERATOR_MCP_TOKEN}", text)

    def test_brain_tools_are_filtered_and_eager(self):
        text = server.build_config(BODY)
        self.assertIn('- "brain_operator_goals"', text)
        self.assertIn("enabled: off", text)
        self.assertIn("fallback_providers:", text)

    def test_the_agent_gets_no_shell_files_browser_or_web(self):
        cmd = server.command(BODY, Path("/tmp/p.txt"))
        toolsets = cmd[cmd.index("-t") + 1].split(",")
        self.assertEqual(toolsets, ["memory", "skills", "todo", "mcp-brain"])
        for forbidden in ("terminal", "file", "browser", "web", "code_execution"):
            self.assertNotIn(forbidden, toolsets)
        self.assertNotIn("k1", " ".join(cmd))


class Memory(unittest.TestCase):
    def test_only_memory_and_skill_files_cross(self):
        home = Path(tempfile.mkdtemp())
        server.write_memory(home, {
            "memories/MEMORY.md": "a",
            "skills/moot/SKILL.md": "b",
            "../escape.md": "x",
            "skills/../../x/SKILL.md": "y",
            "config.yaml": "z",
        })
        self.assertEqual(server.read_memory(home), {"memories/MEMORY.md": "a", "skills/moot/SKILL.md": "b"})
        self.assertFalse((home.parent / "escape.md").exists())


class Translate(unittest.TestCase):
    def test_tool_results_become_tool_lines_without_their_output(self):
        line = server.translate({"type": "tool_result", "name": "mcp__brain__brain_operator_goals", "output": "secret", "is_error": False})
        self.assertEqual(line, {"type": "tool", "tool": "mcp__brain__brain_operator_goals", "ok": True})
        self.assertNotIn("secret", json.dumps(line))
        self.assertIsNone(server.translate({"type": "text", "text": "x"}))

    def test_a_failed_tool_says_why_in_one_line(self):
        line = server.translate({"type": "tool_result", "name": "t", "output": "Not found.\nmore", "is_error": True})
        self.assertEqual(line["error"], "Not found.")


class Results(unittest.TestCase):
    def test_a_finished_result_is_kept_for_a_bounded_number_of_runs(self):
        server.RESULTS.clear()
        for n in range(server.RESULTS_KEPT + 3):
            server.RESULTS[f"opr_{n}"] = {"type": "result"}
            while len(server.RESULTS) > server.RESULTS_KEPT:
                server.RESULTS.pop(next(iter(server.RESULTS)))
        self.assertEqual(len(server.RESULTS), server.RESULTS_KEPT)
        self.assertNotIn("opr_0", server.RESULTS)

    def test_the_machine_never_counts_as_idle_while_a_run_holds_the_lock(self):
        server.touch()
        start = server.ACTIVITY["at"]
        self.assertLess(server.idle_for(start + 5), 6)
        self.assertGreater(server.idle_for(start + server.IDLE_STOP_SECONDS + 1), server.IDLE_STOP_SECONDS)
        with server.LOCK:
            self.assertIsNone(server.idle_for(start + 10 * server.IDLE_STOP_SECONDS))


class Deadline(unittest.TestCase):
    """opr_681f7877 and opr_fc22b38c: a silent Hermes outran its budget by 13 and 29 minutes."""

    def _run(self, script: str, budget: int):
        original_command, original_grace, original_preflight = server.command, server.BUDGET_GRACE_SECONDS, server.preflight
        server.command = lambda body, prompt: [sys.executable, "-c", script]
        server.BUDGET_GRACE_SECONDS = 0
        server.preflight = lambda mcp: "HTTP 200 in 1 ms"
        try:
            started = time.time()
            result = server.run_operator(dict(BODY, budgetSeconds=budget), lambda obj: None)
            return result, time.time() - started
        finally:
            server.command, server.BUDGET_GRACE_SECONDS, server.preflight = original_command, original_grace, original_preflight

    def test_a_silent_run_is_stopped_at_its_deadline(self):
        result, took = self._run("import time; time.sleep(60)", 1)
        self.assertLess(took, 15)
        self.assertEqual(result["error"], "the run exceeded its budget")

    def test_stderr_never_fills_and_freezes_the_run(self):
        script = (
            "import sys, json\n"
            "sys.stderr.write('x' * 2_000_000)\n"
            "print(json.dumps({'type': 'result', 'text': 'done'}), flush=True)\n"
        )
        result, took = self._run(script, 30)
        self.assertLess(took, 20)
        self.assertIsNone(result["error"])
        self.assertEqual(result["final"], "done")

    def test_a_finished_run_keeps_its_tool_events(self):
        script = (
            "import json\n"
            "print(json.dumps({'type': 'tool_result', 'name': 'brain_operator_goal'}), flush=True)\n"
            "print(json.dumps({'type': 'result', 'text': 'ok'}), flush=True)\n"
        )
        result, _ = self._run(script, 30)
        self.assertEqual(result["tools"], 1)
        self.assertIsNone(result["error"])


if __name__ == "__main__":
    unittest.main()
