"""The operator app's own rules, run inside the image that ships (agents.yml operator-deploy)."""
import json
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
