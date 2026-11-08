"""离线回归；文件只写入脚本旁的 .test-output，模型与网络均使用替身。"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import briefing as b

REAL_POPEN = subprocess.Popen


def sample_text():
    return ("## 今天最值得看\n- 新研究 [L1]\n\n## 模型发布\n今天没有\n\n"
            "## 后训练\n### 研究\n结果 [L1]\n\n## 推荐\n今天没有\n\n## Agent\n今天没有\n")


class BriefingTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parent / ".test-output"
        test_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="offline-", dir=test_root)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.args = b.parse_args(["--output-dir", str(self.root / "out"), "--board-dir", str(self.root / "board"), "--no-web"])
        names = ("OUTPUT_DIR", "DATA_DIR", "PROMPT_FILE", "BOARD_DIR", "SITE_DIR", "STATE_FILE", "STATE_BAK",
                 "PENDING_FILE", "LOG_FILE", "RUNS_DIR", "LOCK_FILE", "WEB_ENABLED", "CODEX_ENABLED", "CLAUDE_MODEL",
                 "CLAUDE_EFFORT", "MODEL", "EFFORT", "ACCOUNT_CONFIGS", "DEADLINE")
        self.globals = {key: getattr(b, key) for key in names}
        b.configure(self.args)
        b.DATA_DIR.mkdir(parents=True)
        b.BOARD_DIR.mkdir()
        b.DEADLINE = None
        b.ACCOUNT_CONFIGS = {"a": None}
        self.now = datetime(2026, 4, 8, 5, tzinfo=timezone.utc)
        self.day = self.now.astimezone().date()
        self.item = {"src": "ainews", "key": "ainews:sample", "title": "示例研究", "url": "https://example.org/news",
                     "time": self.now - timedelta(hours=1), "body": "公开研究摘要", "cut": 0}
        self.popen_guard = mock.patch.object(b.subprocess, "Popen", side_effect=AssertionError("离线测试不能调用真实 CLI"))
        self.http_guard = mock.patch.object(b.urllib.request, "urlopen", side_effect=AssertionError("离线测试不能联网"))
        self.popen_guard.start()
        self.http_guard.start()

    def tearDown(self):
        self.http_guard.stop()
        self.popen_guard.stop()
        for key, value in self.globals.items():
            setattr(b, key, value)
        self.temp.cleanup()

    def write_accounts(self, rows):
        (b.BOARD_DIR / "accounts.json").write_text(json.dumps({"accounts": rows}), "utf-8")

    def fake_claude(self, prompt, run_dir, acct, timeout=None):
        return {"status": "ok", "text": sample_text(), "error": "", "usage_text": "示例用量", "secs": 1,
                "model": b.CLAUDE_MODEL, "effort": b.CLAUDE_EFFORT, "acct": acct}

    def collection(self, failures=None):
        return ([dict(self.item)], {"ainews": {"checked": self.now.isoformat()}}, failures or [], [],
                {"ainews": (self.now - timedelta(hours=36)).isoformat()})

    def test_cli_parameters_override_environment(self):
        with mock.patch.dict(os.environ, {"AI_BRIEFING_OUTPUT_DIR": str(self.root / "env"), "AI_BRIEFING_WEB": "true"}):
            args = b.parse_args(["--output-dir", str(self.root / "arg"), "--no-web"])
        self.assertEqual(args.output_dir, str(self.root / "arg"))
        self.assertFalse(args.web)

    def test_default_output_uses_home(self):
        with mock.patch.object(Path, "home", return_value=self.home), mock.patch.dict(os.environ, {}, clear=True):
            args = b.parse_args([])
        self.assertEqual(Path(args.output_dir), self.home / "AI-Briefing")

    def test_invalid_model_and_date_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in (["--claude-model", "../bad"], ["--date", "2026-04-08"]):
                with self.assertRaises(SystemExit):
                    b.parse_args(argv)

    def test_missing_board_uses_primary_without_credentials_file(self):
        with mock.patch.object(Path, "home", return_value=self.home):
            self.assertEqual(b.claude_accounts(), ["a"])
        self.assertEqual(b.ACCOUNT_CONFIGS, {"a": None})

    def test_accounts_sort_week_five_expired_and_unknown(self):
        self.write_accounts([{"id": x, "configDir": None if x == "a" else ".claude-" + x} for x in "abcde"])
        for acct, week, five, reset in (("a", 95, 10, 1000), ("b", 15, 50, 1000), ("c", 15, 20, 1000), ("d", 100, 100, -1)):
            snapshot = {"week": {"pct": week, "reset": time.time() + reset}, "five": {"pct": five, "reset": time.time() + reset}}
            (b.BOARD_DIR / f"acct-{acct}.json").write_text(json.dumps(snapshot), "utf-8")
        with mock.patch.object(Path, "home", return_value=self.home):
            self.assertEqual(b.claude_accounts(), list("dcbae"))

    def test_invalid_account_directory_falls_back(self):
        self.write_accounts([{"id": "b", "configDir": "../../outside"}])
        with mock.patch.object(Path, "home", return_value=self.home):
            self.assertEqual(b.claude_accounts(), ["a"])

    def test_primary_environment_removes_auth_overrides(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "example", "ANTHROPIC_BASE_URL": "https://example.invalid",
                                         "CLAUDE_CONFIG_DIR": "unexpected", "CLAUDE_CODE_USE_VERTEX": "1", "CLAUDECODE": "1"}):
            env = b.claude_env("a")
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_VERTEX", "CLAUDECODE"):
            self.assertNotIn(key, env)
        self.assertEqual(env["CLAUDE_CODE_EFFORT_LEVEL"], "max")

    def test_secondary_settings_and_config_dir_are_explicit(self):
        b.ACCOUNT_CONFIGS = {"b": ".claude-b"}
        account = self.home / ".claude-b"
        account.mkdir()
        (account / "account-settings.json").write_text("{}", "utf-8")
        calls = []

        def fake_proc(args, prompt, stdin, out, err, timeout, **kw):
            calls.append((args, kw))
            out.write_text(json.dumps({"result": sample_text()}), "utf-8")
            err.write_text("", "utf-8")
            return 0, False, False

        with mock.patch.object(Path, "home", return_value=self.home), mock.patch.object(b, "cli_command", return_value=["claude"]), mock.patch.object(b, "run_proc", side_effect=fake_proc):
            result = b.run_claude("提示词", self.root, "b")
        self.assertEqual(result["status"], "ok")
        args, kw = calls[0]
        self.assertEqual(args[args.index("--settings") + 1], str(account / "account-settings.json"))
        self.assertEqual(kw["env"]["CLAUDE_CONFIG_DIR"], str(account))
        self.assertEqual(args[args.index("--setting-sources") + 1], "")
        self.assertEqual(args[args.index("--tools") + 1], "")

    def test_secondary_settings_cannot_reintroduce_api_auth(self):
        b.ACCOUNT_CONFIGS = {"b": ".claude-b"}
        account = self.home / ".claude-b"
        account.mkdir()
        path = account / "account-settings.json"
        for settings in ({"env": {"ANTHROPIC_API_KEY": "example"}}, {"apiKeyHelper": "example"}, {"forceLoginMethod": "console"}):
            path.write_text(json.dumps(settings), "utf-8")
            with mock.patch.object(Path, "home", return_value=self.home):
                with self.assertRaises(ValueError):
                    b.check_account_settings("b")

    def test_primary_cli_uses_no_settings_override(self):
        calls = []

        def fake_proc(args, prompt, stdin, out, err, timeout, **kw):
            calls.append((args, kw))
            out.write_text(json.dumps({"result": sample_text()}), "utf-8")
            err.write_text("", "utf-8")
            return 0, False, False

        with mock.patch.object(b, "cli_command", return_value=["claude"]), mock.patch.object(b, "run_proc", side_effect=fake_proc):
            self.assertEqual(b.run_claude("提示词", self.root, "a")["status"], "ok")
        self.assertNotIn("--settings", calls[0][0])
        self.assertNotIn("CLAUDE_CONFIG_DIR", calls[0][1]["env"])

    def test_codex_uses_official_login_and_ignores_external_config(self):
        calls = []

        def fake_proc(args, prompt, stdin, out, err, timeout, **kw):
            calls.append((args, kw))
            Path(args[args.index("-o") + 1]).write_text(sample_text(), "utf-8")
            out.write_text(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1}}), "utf-8")
            err.write_text("", "utf-8")
            return 0, False, False

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "example", "CODEX_HOME": "unexpected"}), mock.patch.object(Path, "home", return_value=self.home), mock.patch.object(b, "cli_command", return_value=["codex"]), mock.patch.object(b, "run_proc", side_effect=fake_proc):
            self.assertEqual(b.run_codex("提示词", self.root, b.MODEL)["status"], "ok")
        args, kw = calls[0]
        for value in ('model_provider="openai"', 'forced_login_method="chatgpt"', "--ignore-user-config", "--ephemeral", "read-only"):
            self.assertIn(value, args)
        self.assertNotIn("OPENAI_API_KEY", kw["env"])
        self.assertEqual(kw["env"]["CODEX_HOME"], str(self.home / ".codex"))

    def test_generate_tries_all_accounts_then_codex(self):
        meta = {"counts": {"L": 1, "J": 0, "H": 0}, "links": {"L1": ["来源", "https://example.org"]}, "coverage": "示例", "failures": []}
        attempts = []

        def fake_attempt(prompt, run_dir, links, model, acct=None, timeout=None):
            attempts.append(acct or "codex")
            return {"status": "error" if acct else "ok", "model": model, "acct": acct, "effort": "high",
                    "error": "示例失败" if acct else "", "body": sample_text(), "usage_text": "示例"}

        with mock.patch.object(b, "cli_command", return_value=["available"]), mock.patch.object(b, "claude_accounts", return_value=["a", "b"]), mock.patch.object(b, "attempt", side_effect=fake_attempt):
            self.assertTrue(b.generate("素材", meta, self.root, self.day, "ok", False))
        self.assertEqual(attempts, ["a", "b", "codex"])

    def test_missing_codex_is_skipped(self):
        with mock.patch.object(b, "cli_command", return_value=None), mock.patch.object(b, "attempt") as attempt:
            self.assertFalse(b.generate("素材", {"counts": {"L": 1}, "links": {}}, self.root, self.day, "ok", False))
        attempt.assert_not_called()

    def test_dry_run_writes_material_prompt_items_without_state_changes(self):
        b.STATE_FILE.write_text('{"seen":{}}', "utf-8")
        b.PENDING_FILE.write_text('{"items":[]}', "utf-8")
        state, pending = b.STATE_FILE.read_bytes(), b.PENDING_FILE.read_bytes()
        self.args.dry_run = True
        with mock.patch.object(b, "collect", return_value=self.collection()), mock.patch.object(b, "generate", side_effect=AssertionError("干跑不能生成简报")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(b.run(self.args, self.now, self.day, None), 0)
        folder = b.RUNS_DIR / self.day.isoformat() / "dry-run"
        for name in ("material.md", "prompt.md", "items.json", "meta.json"):
            self.assertGreater((folder / name).stat().st_size, 0)
        self.assertEqual(state, b.STATE_FILE.read_bytes())
        self.assertEqual(pending, b.PENDING_FILE.read_bytes())
        self.assertFalse(b.note_path(self.day).exists())

    def test_dry_run_reports_partial_fetch(self):
        self.args.dry_run = True
        with mock.patch.object(b, "collect", return_value=self.collection(["HF 暂不可用"])), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(b.run(self.args, self.now, self.day, None), 2)
        self.assertFalse(b.STATE_FILE.exists())

    def test_model_failure_keeps_pending_and_does_not_advance_state(self):
        with mock.patch.object(b, "collect", return_value=self.collection()), mock.patch.object(b, "cli_command", return_value=None):
            self.assertEqual(b.run(self.args, self.now, self.day, None), 1)
        self.assertFalse(b.STATE_FILE.exists())
        self.assertEqual(b.read_json(b.PENDING_FILE)["items"][0]["key"], self.item["key"])
        self.assertEqual(b.note_status(self.day), "failed")

    def test_partial_retry_merges_already_written_items(self):
        paper = {"src": "hf", "key": "hf:0000.00000", "pid": "0000.00000", "day": self.day - timedelta(days=1),
                 "title": "示例论文", "url": "https://huggingface.co/papers/0000.00000", "upvotes": 1,
                 "keywords": [], "one_line": "", "body": "摘要", "code": False, "media": ""}
        second = ([paper], {"hf": {"last_date": paper["day"].isoformat()}}, [], [], {"hf": [paper["day"].isoformat()]})
        with mock.patch.object(b, "collect", side_effect=[self.collection(["HF 暂不可用"]), second]), mock.patch.object(b, "cli_command", return_value=["available"]), mock.patch.object(b, "claude_accounts", return_value=["a"]), mock.patch.object(b, "run_claude", side_effect=self.fake_claude):
            self.assertEqual(b.run(self.args, self.now, self.day, None), 2)
            self.assertEqual(b.run(self.args, self.now, self.day, "partial"), 0)
        snap = b.read_json(b.RUNS_DIR / self.day.isoformat() / "note.json")
        self.assertEqual({row["key"] for row in snap["items"]}, {self.item["key"], paper["key"]})
        self.assertEqual(b.note_status(self.day), "ok")

    def test_recover_commits_only_matching_batch(self):
        folder = b.RUNS_DIR / self.day.isoformat()
        folder.mkdir(parents=True)
        meta = {"batch": "b123", "keys": [self.item["key"]], "updates": {"ainews": {"checked": self.now.isoformat()}}}
        (folder / "meta.json").write_text(b.dump(meta), "utf-8")
        (folder / "items.json").write_text(b.dump(b.enc_items([self.item])), "utf-8")
        b.write_note(self.day, "ok", "内容", "other")
        b.recover(self.day)
        self.assertFalse(b.STATE_FILE.exists())
        b.write_note(self.day, "ok", "内容", "b123")
        b.recover(self.day)
        self.assertTrue(b.read_json(folder / "meta.json")["committed"])
        self.assertEqual(b.load_state()["ainews"]["checked"], self.now.isoformat())

    def test_no_new_material_never_calls_model(self):
        meta = {"counts": {"L": 0, "J": 0, "H": 0}, "coverage": "示例", "failures": []}
        with mock.patch.object(b, "cli_command", side_effect=AssertionError("空素材无需 CLI")):
            self.assertTrue(b.generate("素材", meta, self.root, self.day, "ok", False))

    def test_hf_uses_completed_utc_days(self):
        now = datetime(2026, 4, 1, 1, tzinfo=timezone(timedelta(hours=14)))
        days, _ = b.hf_days(None, now)
        self.assertEqual(days[-1], date(2026, 3, 30))

    def test_jiqizhixin_only_one_list_request(self):
        raw = {"articles": [{"id": 1, "slug": "sample", "publishedAt": "2026/04/08 12:00", "title": "示例", "content": "摘录", "tagList": []}]}
        with mock.patch.object(b, "http_get", return_value=json.dumps(raw).encode()) as get:
            items, _, count = b.fetch_jiqizhixin(self.now - timedelta(days=1))
        self.assertEqual(count, 1)
        self.assertEqual(len(items), 1)
        get.assert_called_once_with("https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=1&per=20")

    def test_hf_stops_at_first_failed_day(self):
        days = [date(2026, 4, 6), date(2026, 4, 7), date(2026, 4, 8)]
        with mock.patch.object(b, "http_get", side_effect=[b"[]", ValueError("示例错误")]) as get:
            _, done, err = b.fetch_hf(days)
        self.assertEqual(done, days[0])
        self.assertIsInstance(err, ValueError)
        self.assertEqual(get.call_count, 2)
        self.assertIn("limit=100", get.call_args_list[0].args[0])

    def test_ainews_text_is_taken_from_rss(self):
        rss = b'<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><guid>one</guid><title>Sample</title><link>https://example.org/news</link><pubDate>Wed, 08 Apr 2026 04:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Content</p><h2>Less Technical AI Subreddit Recap</h2><p>Other</p>]]></content:encoded></item></channel></rss>'
        with mock.patch.object(b, "http_get", return_value=rss) as get:
            items = b.fetch_ainews(self.now - timedelta(days=1))
        self.assertEqual(items[0]["body"], "Content")
        get.assert_called_once_with("https://latent.space/feeds/news.xml", timeout=60)

    def test_unknown_reference_is_rejected(self):
        text, unknown, used = b.finalize_body(sample_text() + "\n[H999]", {"L1": ["来源", "https://example.org"]})
        self.assertIn("H999", b.reply_problem(text, unknown, used))

    def test_web_is_optional_and_links_are_relative(self):
        with mock.patch.object(b, "build_site") as build:
            path = b.write_note(self.day, "ok", sample_text())
            self.assertNotIn("网页版", path.read_text("utf-8"))
            build.assert_not_called()
        b.WEB_ENABLED = True
        path = b.write_note(self.day, "ok", sample_text())
        self.assertIn(f"../site/{self.day.isoformat()}.html", path.read_text("utf-8"))
        self.assertTrue((b.SITE_DIR / "index.html").is_file())
        self.assertTrue((b.SITE_DIR / f"{self.day.isoformat()}.html").is_file())

    def test_web_drops_script_links_and_escapes_html(self):
        rendered = b.md_inline('[示例](javascript:alert) <script>example</script>')
        self.assertNotIn("href=", rendered)
        self.assertNotIn("<script>", rendered)

    def test_arxiv_prefers_results_and_excludes_tables(self):
        page = ('<figure><img src="overview.png"><figcaption>Architecture overview</figcaption></figure>'
                '<figure class="ltx_table"><img src="table.png"><figcaption>Best results</figcaption></figure>'
                '<figure><object data="result.svg"></object><figcaption>Benchmark performance</figcaption></figure>')
        with mock.patch.object(b, "fetch_page", return_value=(page, "https://arxiv.org/html/0000.00000/")):
            figure = b.arxiv_figure("0000.00000")
        self.assertTrue(figure["src"].endswith("result.svg"))

    def test_existing_live_lock_is_never_removed(self):
        b.LOCK_FILE.write_text(str(os.getpid()), "utf-8")
        os.utime(b.LOCK_FILE, (time.time() - 10000, time.time() - 10000))
        with mock.patch.object(b, "pid_alive", return_value=True):
            self.assertFalse(b.acquire_lock())
        self.assertTrue(b.LOCK_FILE.exists())

    def test_timeout_stops_only_owned_python_child(self):
        self.popen_guard.stop()
        try:
            rc, timed_out, stuck = b.run_proc([sys.executable, "-X", "utf8", "-c", "import time; time.sleep(10)"],
                                             "", self.root / "input.txt", self.root / "out.txt", self.root / "err.txt", 0.3)
        finally:
            self.popen_guard.start()
        self.assertTrue(timed_out)
        self.assertFalse(stuck)
        self.assertFalse((self.root / "input.txt").exists())

    @unittest.skipUnless(os.name == "nt", "Windows 脚本宿主仅在 Windows 测试")
    def test_vbs_forwards_unicode_empty_and_trailing_slash_arguments(self):
        folder = self.root / "launcher space"
        folder.mkdir()
        launcher = folder / "briefing-hidden.vbs"
        shutil.copyfile(Path(b.__file__).with_name("briefing-hidden.vbs"), launcher)
        (folder / "briefing.py").write_text(
            'import json, sys\nfrom pathlib import Path\n'
            'Path(__file__).with_name("args.json").write_text(json.dumps(sys.argv[1:], ensure_ascii=False), "utf-8")\n'
            'raise SystemExit(7)\n', "utf-8")
        arguments = ["--output-dir", str(folder / "中文 空格") + "\\", "", "--web"]
        command = " ".join('"' + value + '"' for value in ["cscript.exe", "//Nologo", str(launcher), sys.executable, *arguments])
        with mock.patch.object(subprocess, "Popen", REAL_POPEN):
            result = subprocess.run(command, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 7, result.stderr.decode(errors="replace"))
        self.assertEqual(json.loads((folder / "args.json").read_text("utf-8")), arguments)


if __name__ == "__main__":
    unittest.main()
