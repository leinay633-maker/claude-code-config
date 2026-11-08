"""抓取公开 AI 新闻，以官方 CLI 的登录账号生成中文简报。"""

import argparse
import html as htmllib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = Path.home() / "AI-Briefing"
DATA_DIR = OUTPUT_DIR / ".briefing"
PROMPT_FILE = SCRIPT_DIR / "prompt.md"
BOARD_DIR = Path.home() / ".claude" / "board"
STATE_FILE = DATA_DIR / "state.json"
STATE_BAK = DATA_DIR / "state.json.bak"
PENDING_FILE = DATA_DIR / "pending.json"
LOG_FILE = DATA_DIR / "briefing.log"
RUNS_DIR = DATA_DIR / "runs"
LOCK_FILE = DATA_DIR / "briefing.lock"
SITE_DIR = OUTPUT_DIR / "site"
WEB_ENABLED = False
CODEX_ENABLED = True
ACCOUNT_CONFIGS = {"a": None}
BJ = timezone(timedelta(hours=8))
UA = "ai-briefing/1.0 (daily digest)"
CLAUDE_MODEL = "claude-opus-5-5"
CLAUDE_EFFORT = "max"
CLAUDE_TIMEOUT = 20 * 60
CLAUDE_SYSTEM = "你是一份中文 AI 日报的编辑。照用户消息里的要求写简报，只输出简报正文。"
MODEL = "gpt-6.1-sol"
EFFORT = "high"
CODEX_TIMEOUT = 15 * 60
RUN_BUDGET = 55 * 60
SOL_RESERVE = 8 * 60
WRAP_RESERVE = 2 * 60
KILL_RESERVE = 60
DEADLINE = None
FIRST_LOOKBACK = timedelta(hours=36)
OVERLAP = timedelta(hours=6)
MAX_CATCHUP = timedelta(days=3)
HF_MAX_DAYS = 3
AINEWS_MAX_CHARS = 45000
HF_ABSTRACT_BUDGET = 100000
HF_ABSTRACT_SHORT = 600
KEEP_RUNS_DAYS = 60
KEEP_SEEN_DAYS = 10
SOURCES = ("ainews", "jiqizhixin", "hf")
RETRY = (None, "failed", "partial")


def now_local():
    return datetime.now().astimezone()


def fmt_time(dt):
    return dt.astimezone().strftime("%m-%d %H:%M")


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    if value.lower() in ("1", "true", "yes", "on"):
        return True
    if value.lower() in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"{name} 应为 true 或 false")


def configure(args):
    global OUTPUT_DIR, DATA_DIR, PROMPT_FILE, BOARD_DIR, SITE_DIR
    global STATE_FILE, STATE_BAK, PENDING_FILE, LOG_FILE, RUNS_DIR, LOCK_FILE
    global WEB_ENABLED, CODEX_ENABLED, CLAUDE_MODEL, CLAUDE_EFFORT, MODEL, EFFORT
    OUTPUT_DIR = Path(args.output_dir).expanduser().resolve()
    DATA_DIR = OUTPUT_DIR / ".briefing"
    PROMPT_FILE = Path(args.prompt_file).expanduser().resolve()
    BOARD_DIR = Path(args.board_dir).expanduser().resolve()
    SITE_DIR = OUTPUT_DIR / "site"
    STATE_FILE = DATA_DIR / "state.json"
    STATE_BAK = DATA_DIR / "state.json.bak"
    PENDING_FILE = DATA_DIR / "pending.json"
    LOG_FILE = DATA_DIR / "briefing.log"
    RUNS_DIR = DATA_DIR / "runs"
    LOCK_FILE = DATA_DIR / "briefing.lock"
    WEB_ENABLED, CODEX_ENABLED = args.web or args.site, args.codex
    CLAUDE_MODEL, CLAUDE_EFFORT = args.claude_model, args.claude_effort
    MODEL, EFFORT = args.codex_model, args.codex_effort


def cli_command(name):
    """直接运行安装包入口，避免 Windows 批处理转发丢失空字符串参数。"""
    found = shutil.which(name)
    if not found:
        return None
    path = Path(found).resolve()
    if path.suffix.lower() not in (".cmd", ".bat", ".ps1"):
        return [str(path)]
    package = path.parent / "node_modules"
    if name == "claude":
        native = package / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if native.is_file():
            return [str(native)]
        entry = package / "@anthropic-ai" / "claude-code" / "cli.js"
    else:
        entry = package / "@openai" / "codex" / "bin" / "codex.js"
    node = shutil.which("node")
    return [node, str(entry)] if node and entry.is_file() else None


def claude_accounts():
    """周用量优先、五小时用量次之；已过重置时间视为零，未知用量排最后。"""
    global ACCOUNT_CONFIGS
    accounts = {"a": None}
    try:
        data = json.loads((BOARD_DIR / "accounts.json").read_text("utf-8-sig"))
        rows = data["accounts"]
        if not isinstance(rows, list) or not rows:
            raise ValueError("accounts 应为非空列表")
        accounts = {}
        home = Path.home().resolve()
        for row in rows:
            acct, config = row["id"], row["configDir"]
            if not isinstance(acct, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", acct) or acct in accounts:
                raise ValueError("账号 id 无效或重复")
            if config is not None:
                if not isinstance(config, str) or not config or Path(config).is_absolute():
                    raise ValueError("configDir 应为家目录内的相对路径或 null")
                resolved = (home / config).resolve()
                if not resolved.is_relative_to(home) or resolved == home:
                    raise ValueError("configDir 超出账号配置目录范围")
            accounts[acct] = config
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError, KeyError):
        log("账号清单不可用，只尝试主号")
        accounts = {"a": None}
    ACCOUNT_CONFIGS = accounts
    now = time.time()

    def used(acct):
        try:
            snap = json.loads((BOARD_DIR / f"acct-{acct}.json").read_text("utf-8-sig"))
            values = []
            for key in ("week", "five"):
                window = snap[key]
                if window is None:
                    values.append(0.0)
                    continue
                reset, pct = float(window.get("reset") or 0), float(window["pct"])
                if not math.isfinite(reset) or not math.isfinite(pct) or not 0 <= pct <= 100:
                    raise ValueError("用量无效")
                values.append(pct if reset > now else 0.0)
            return tuple(values)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return (101.0, 101.0)

    return sorted(accounts, key=used)


def claude_dir(acct):
    config = ACCOUNT_CONFIGS[acct]
    return Path.home() / (config if config is not None else ".claude")


def claude_env(acct):
    """清除会改变登录方式和账号选择的继承变量。"""
    drop = {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_HELPER"}
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_")) and k.upper() not in drop}
    if ACCOUNT_CONFIGS[acct] is not None:
        env["CLAUDE_CONFIG_DIR"] = str(claude_dir(acct))
    env["CLAUDE_CODE_EFFORT_LEVEL"] = CLAUDE_EFFORT
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "128000"
    return env


def check_account_settings(acct):
    """显式账号配置也不能重新注入 API 凭证或其他登录方式。"""
    if ACCOUNT_CONFIGS[acct] is None:
        return None
    path = claude_dir(acct) / "account-settings.json"
    settings = json.loads(path.read_text("utf-8-sig"))
    if not isinstance(settings, dict) or not isinstance(settings.get("env", {}), dict):
        raise ValueError("账号 settings 格式无效")
    forbidden = ("ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_API_KEY_HELPER")
    if (settings.get("apiKeyHelper") or settings.get("forceLoginMethod", "claudeai") != "claudeai"
            or any(k.upper().startswith(forbidden) for k in settings.get("env", {}))):
        raise ValueError("账号 settings 必须使用官方订阅登录")
    return path


def codex_env():
    drop = {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME", "CODEX_PROFILE",
            "CODEX_CONFIG_PROFILE", "CODEX_MANAGED_CONFIG_PATH"}
    env = {k: v for k, v in os.environ.items() if k.upper() not in drop}
    env["CODEX_HOME"] = str(Path.home() / ".codex")
    return env


def note_path(day):
    return OUTPUT_DIR / f"{day:%Y-%m}" / f"{day:%Y-%m-%d}.md"


def write_note(day, status, body, batch=None):
    """先原子写正文，之后按 batch 恢复尚未提交的抓取水位。"""
    path = note_path(day)
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = f"date: {day:%Y-%m-%d}\nstatus: {status}\n" + (f"batch: {batch}\n" if batch else "")
    link = f"[网页版](../site/{day:%Y-%m-%d}.html)\n\n" if WEB_ENABLED else ""
    atomic_write(path, f"---\n{fm}---\n\n{link}{body.rstrip()}\n")
    if WEB_ENABLED:
        try:
            build_site()
        except Exception:
            log("网页版没生成：" + traceback.format_exc().replace("\n", " | "))
    return path


def failed_body(step, error, today):
    return (f"今天的简报没生成，卡在{step}。\n\n报错原文：\n\n```\n{error}\n```\n\n"
            "已抓到的条目会在下次运行时重试，也可以手动运行 `python -X utf8 briefing.py`。\n")


def make_prompt(material, today):
    return (PROMPT_FILE.read_text("utf-8-sig").strip()
            + f"\n\n今天的本地日期是 {today:%Y-%m-%d}。材料中的新闻时间均为本地时间。\n\n" + material)


def attempt(prompt, run_dir, links, model, acct=None, timeout=None):
    r = run_claude(prompt, run_dir, acct, timeout) if acct is not None else run_codex(prompt, run_dir, model, timeout)
    if r["status"] == "ok":
        r["body"], unknown, used = finalize_body(r["text"], links)
        problem = reply_problem(r["body"], unknown, used)
        if problem:
            r["status"], r["error"] = "bad-reply", problem
    return r


def generate(material, meta, run_dir, today, final, keep):
    prompt = make_prompt(material, today)
    atomic_write(run_dir / "prompt.md", prompt)
    if not any(meta["counts"].values()):
        body = "## 今天最值得看\n\n- 这段时间三个来源都没有新内容。\n\n"
        body += "".join(f"## {h}\n\n今天没有\n\n" for h in EMPTY_SECTIONS)
        write_note(today, final, body + "---\n\n" + footer(meta, None), meta.get("batch"))
        return True
    tries = []
    if cli_command("claude"):
        for acct in claude_accounts():
            budget = min(CLAUDE_TIMEOUT, left() - SOL_RESERVE - WRAP_RESERVE - KILL_RESERVE)
            if budget < 180:
                log("剩余时间留给备用模型")
                break
            r = attempt(prompt, run_dir, meta["links"], CLAUDE_MODEL, acct, budget)
            tries.append(r)
            if r["status"] == "ok":
                break
            log(f"{who(r)} {r['status']}：{r['error']}")
    else:
        log("PATH 中没有可用的 Claude CLI")
    if (not tries or tries[-1]["status"] != "ok") and CODEX_ENABLED:
        if cli_command("codex"):
            budget = min(CODEX_TIMEOUT, left() - WRAP_RESERVE - KILL_RESERVE)
            tries.append(attempt(prompt, run_dir, meta["links"], MODEL, timeout=budget) if budget >= 60 else no_time(MODEL))
        else:
            log("PATH 中没有可用的 Codex CLI，跳过备用模型")
    if not tries or tries[-1]["status"] != "ok":
        error = "\n".join(f"{who(r)}：{r['error']}" for r in tries) or "没有可用的官方 CLI，请完成安装及订阅登录"
        if not keep:
            write_note(today, "failed", failed_body("调用模型", error, today))
        return False
    r = tries[-1]
    meta["model"] = r["model"]
    made = f"{r['model']}（{r['effort']}）"
    if r.get("acct"):
        made += f"，账号 {r['acct']}"
    else:
        made += "，Claude 本次未完成"
    atomic_write(run_dir / "usage.json", dump({"model": r["model"], "summary": r["usage_text"]}))
    if WEB_ENABLED:
        try:
            gather_figures(r["body"], run_dir)
        except Exception:
            log("配图出错：" + traceback.format_exc().replace("\n", " | "))
    path = write_note(today, final, r["body"] + "\n\n---\n\n" + footer(meta, made), meta.get("batch"))
    log(f"{final}  {r['model']}  {r['usage_text']}  {path}")
    return True


def stop_tree(p):
    """只按本次启动的 PID 结束子进程树。"""
    if p.poll() is not None:
        return True
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, timeout=20)
        else:
            os.killpg(p.pid, signal.SIGKILL)
        p.wait(timeout=20)
        return True
    except (OSError, subprocess.TimeoutExpired):
        try:
            p.kill()
            p.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return p.poll() is not None


def pid_alive(pid):
    """Windows 的 os.kill(pid, 0) 不用于存活检查。"""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except ProcessLookupError:
            return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ctypes.get_last_error() == 5
    try:
        code = wintypes.DWORD()
        return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        kernel.CloseHandle(handle)


def errtext(e):
    return re.sub(r"\s+", " ", f"{type(e).__name__}: {e}").strip()


def log(msg):

    line = f"{now_local():%Y-%m-%d %H:%M:%S}  {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
    except OSError:
        pass


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1)


def read_json(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None
    except ValueError as e:
        log(f"{path.name} 读不了（{errtext(e)}），当它不存在")
        return None


def atomic_write(path, text, tmp_dir=None):

    tmp = Path(tmp_dir or path.parent) / (path.name + ".tmp")
    for i in range(5):
        try:
            tmp.write_text(text, "utf-8", newline="\n")
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == 4:
                raise
            time.sleep(1 + i)


def bounded(fn, limit):
    """在后台线程里跑 fn，最多等 limit 秒。socket 超时只管单次收发，服务器一点点慢慢回数据时整个请求能拖很久；
    超时的线程是 daemon，不再等它，进程退出时一起结束。"""
    if limit <= 0:
        raise TimeoutError("这次运行的时间用完了")
    box = {}

    def work():
        try:
            box["v"] = fn()
        except BaseException as e:
            box["e"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(limit)
    if t.is_alive():
        raise TimeoutError(f"{limit:.0f} 秒没读完")
    if "e" in box:
        raise box["e"]
    return box["v"]


def http_once(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.geturl()


def http_get(url, timeout=30, tries=3):
    """每次请求最多 2 倍 timeout，也不超过这次运行剩下的时间（留出收尾）；剩下的时间不够就不再等着重试。"""
    err = None
    for i in range(tries):
        if i:
            if left() < 15 * i + 2 * timeout + SOL_RESERVE + WRAP_RESERVE:
                break
            time.sleep(15 * i)
        try:
            return bounded(lambda: http_once(url, timeout)[0], min(2 * timeout, left() - WRAP_RESERVE))
        except Exception as e:
            err = e
    raise err


class _TextOf(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "blockquote", "section", "article", "hr"}
    HEAD = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in self.HEAD:
            self.parts.append("\n【")
        elif tag in self.BLOCK:
            self.parts.append("\n- " if tag == "li" else "\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.HEAD:
            self.parts.append("】\n")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html):
    p = _TextOf()
    p.feed(html)
    p.close()
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v\u00a0]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def fetch_ainews(since):
    root = ET.fromstring(http_get("https://latent.space/feeds/news.xml", timeout=60))
    all_items = list(root.iter("item"))
    if not all_items:
        raise RuntimeError("RSS 里一条 item 都没有，可能改版了")
    items = []
    for it in all_items:
        pub = parsedate_to_datetime(it.findtext("pubDate"))
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        if pub <= since:
            continue
        link = (it.findtext("link") or "").strip()
        html = it.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or it.findtext("description") or ""
        text = html_to_text(html)

        m = re.search(r"【?\s*Less Technical AI Subreddit Recap", text, re.I)
        if m:
            text = text[:m.start()].rstrip()

        cut = max(0, len(text) - AINEWS_MAX_CHARS)
        if cut:
            text = text[:AINEWS_MAX_CHARS].rstrip() + "\n（后文截断）"
        items.append({"src": "ainews", "key": "ainews:" + ((it.findtext("guid") or "").strip() or link),
                      "title": (it.findtext("title") or "").strip(), "url": link, "time": pub, "body": text, "cut": cut})
    items.sort(key=lambda x: x["time"])
    return items


def parse_bj(s):
    s = (s or "").strip()
    for fmt in ("%Y/%m/%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=BJ)
        except ValueError:
            pass
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=BJ)


def fetch_jiqizhixin(since):
    """只调文章列表接口：原 /rss 已停，文章页对脚本返回付费数据服务页；不抓正文、不伪装浏览器去绕。
    接口不认 page 参数、始终返回最近 20 篇，所以只请求一次。
    返回 (条目, 最老一篇的时间, 列表条数)，漏没漏由调用方和上次抓取的时间比。"""
    raw = http_get("https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=1&per=20")
    try:
        data = json.loads(raw)
    except ValueError:
        raise RuntimeError("返回的不是 JSON（可能被挡了），开头是：" + raw[:200].decode("utf-8", "replace")) from None
    arts = data.get("articles") if isinstance(data, dict) else None
    if not arts or not isinstance(arts, list):
        raise RuntimeError("没有文章列表，可能改版或被挡了，返回开头是：" + raw[:200].decode("utf-8", "replace"))
    items, oldest = {}, None
    for a in arts:
        pub = parse_bj(a.get("publishedAt"))
        oldest = pub if oldest is None or pub < oldest else oldest
        if pub <= since:
            continue
        slug = a.get("slug") or ""
        key = "jqzx:" + str(a.get("id") or slug)
        items[key] = {"src": "jiqizhixin", "key": key, "title": (a.get("title") or "").strip(),
                      "url": f"https://www.jiqizhixin.com/articles/{slug}", "time": pub,
                      "tags": [str(t) for t in (a.get("tagList") or [])], "body": (a.get("content") or "").strip()}
    return sorted(items.values(), key=lambda x: x["time"]), oldest, len(arts)


def fetch_hf(days):
    """按日期顺序抓；某天失败（含返回内容解析不了）就停，前面抓到的照用，水位只推进到最后成功的那天。"""
    items, done, err = {}, None, None
    for d in days:
        try:
            arr = json.loads(http_get(f"https://huggingface.co/api/daily_papers?date={d.isoformat()}&limit=100"))
            if not isinstance(arr, list):
                raise RuntimeError("返回的不是论文列表：" + json.dumps(arr, ensure_ascii=False)[:200])
            got = {}
            for ent in arr:
                p = ent.get("paper") or {}
                pid = p.get("id") or ""
                if pid:

                    media = [str(u) for u in (p.get("mediaUrls") or ent.get("mediaUrls") or []) if IMG_EXT.search(str(u).split("?")[0])]
                    got["hf:" + pid] = {
                        "src": "hf", "key": "hf:" + pid, "pid": pid, "day": d, "title": (p.get("title") or ent.get("title") or "").strip(),
                        "url": f"https://huggingface.co/papers/{pid}", "upvotes": int(p.get("upvotes") or 0),
                        "keywords": [str(k) for k in (p.get("ai_keywords") or [])], "one_line": (p.get("ai_summary") or "").strip(),
                        "body": (p.get("summary") or ent.get("summary") or "").strip(), "code": bool(p.get("githubRepo")),
                        "media": media[0] if media else ""}
        except Exception as e:
            err = e
            break
        if len(arr) >= 100:
            log(f"HF {d} 返回满 100 条，可能还有没取到的")
        for k, v in got.items():
            items.setdefault(k, v)
        done = d
    return list(items.values()), done, err


def load_state():
    try:
        return json.loads(STATE_FILE.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as e:
        log(f"state.json 读不了（{errtext(e)}），改用上一份备份")
    try:
        return json.loads(STATE_BAK.read_text("utf-8"))
    except (OSError, ValueError) as e:
        log(f"备份也读不了（{errtext(e)}），按首次运行处理")
        return {}


def save_state(state):
    try:
        json.loads(STATE_FILE.read_text("utf-8"))
        shutil.copyfile(STATE_FILE, STATE_BAK)
    except (OSError, ValueError):
        pass
    atomic_write(STATE_FILE, dump(state))


def newer(src, a, b):
    """同一来源的两个水位取靠后的。HF 记榜单日期，另两个记抓取时间。"""
    if not a or not b:
        return a or b
    if src == "hf":
        return b if b["last_date"] > a["last_date"] else a
    return b if datetime.fromisoformat(b["checked"]) > datetime.fromisoformat(a["checked"]) else a


def merge_updates(*ups):
    out = {}
    for up in ups:
        for src, v in (up or {}).items():
            if src in SOURCES and v:
                out[src] = newer(src, out.get(src), v)
    return out


def time_window(entry, now):
    """返回 (起点, 是否因断档超过 3 天被截短)。"""
    if not entry or not entry.get("checked"):
        return now - FIRST_LOOKBACK, False
    checked = datetime.fromisoformat(entry["checked"])
    floor = now - MAX_CATCHUP
    return max(checked - OVERLAP, floor), checked < floor


def hf_days(entry, now):
    """HF 每日论文按 UTC 日期分榜，周末常常是空榜。某天的榜单什么时候收齐没有准话，
    所以每次把上次抓过的最后一天再抓一遍，后补进来的靠已见 ID 去重补上。
    首次运行抓最近三天，免得碰上周末一篇都没有。返回 (要抓的日期, 是否因断档被截短)。"""
    yesterday = now.astimezone(timezone.utc).date() - timedelta(days=1)
    if not entry or not entry.get("last_date"):
        return [yesterday - timedelta(days=i) for i in (2, 1, 0)], False
    d = date.fromisoformat(entry["last_date"])
    days = []
    while d <= yesterday:
        days.append(d)
        d += timedelta(days=1)
    if len(days) > HF_MAX_DAYS + 1:
        return days[-HF_MAX_DAYS:], True
    return days, False


def enc_items(items):
    return [{k: (v.isoformat() if k in ("time", "day") else v) for k, v in it.items()} for it in items]


def dec_items(rows):
    if isinstance(rows, dict):
        rows = [dict(x, src=src) for src, xs in rows.items() for x in xs]
    out = []
    for r in rows or []:
        try:
            it = dict(r)
            if "time" in it:
                it["time"] = datetime.fromisoformat(it["time"])
            if "day" in it:
                it["day"] = date.fromisoformat(it["day"])
            if it["src"] in SOURCES and it["key"]:
                out.append(it)
        except (KeyError, TypeError, ValueError):
            log(f"存档里有一条读不了，丢掉：{str(r)[:100]}")
    return out


def fresh(it, now):
    """还在补抓范围（3 天）里。"""
    if "time" in it:
        return it["time"] >= now - MAX_CATCHUP
    return it["day"] >= now.date() - timedelta(days=HF_MAX_DAYS)


def load_batch(path):
    """pending.json 和 runs/<日期>/note.json 同一种格式：条目、水位更新、覆盖范围、页脚说明。"""
    data = read_json(path) or {}
    return dec_items(data.get("items")), data.get("updates") or {}, data.get("span") or {}, data.get("notes") or []


def load_pending(now, seen):
    """上次抓到了、没写进简报的条目。进过简报的、超过 3 天的丢掉；丢了过期条目，覆盖范围收到 3 天内，那批的页脚说明也不要了。"""
    items, updates, span, notes = load_batch(PENDING_FILE)
    kept = [x for x in items if x["key"] not in seen and fresh(x, now)]
    if any(not fresh(x, now) for x in items):
        notes = []
    floor, first = now - MAX_CATCHUP, (now.date() - timedelta(days=HF_MAX_DAYS)).isoformat()
    clamped = {}
    for src, v in span.items():
        if src == "hf":
            if any(d >= first for d in v):
                clamped["hf"] = [d for d in v if d >= first]
        else:
            clamped[src] = max(datetime.fromisoformat(v), floor).isoformat()
    return kept, updates, clamped, notes


def drop_pending(keys):
    data = read_json(PENDING_FILE)
    if data is None:
        return
    rest = [x for x in data.get("items") or [] if x.get("key") not in keys]
    if rest:
        data["items"] = rest
        atomic_write(PENDING_FILE, dump(data))
    else:
        PENDING_FILE.unlink(missing_ok=True)


def collect(view, seen, now):
    """抓三个来源在 view 水位之后的新条目，去掉已见的。
    返回 (条目, 水位更新, 失败, 页脚说明, 覆盖范围)；抓失败的来源不进水位更新和覆盖范围，下次从原水位补。"""
    new, updates, failures, notes, span = [], {}, [], [], {}
    truncated = False

    since, cut = time_window(view.get("ainews"), now)
    truncated |= cut
    try:
        new += [x for x in fetch_ainews(since) if x["key"] not in seen]
        updates["ainews"] = {"checked": now.isoformat()}
        span["ainews"] = since.isoformat()
    except Exception as e:
        failures.append(f"AINews（{errtext(e)}）")

    since, cut = time_window(view.get("jiqizhixin"), now)
    truncated |= cut
    try:
        got, oldest, n = fetch_jiqizhixin(since)
        new += [x for x in got if x["key"] not in seen]
        updates["jiqizhixin"] = {"checked": now.isoformat()}
        span["jiqizhixin"] = since.isoformat()

        prev = (view.get("jiqizhixin") or {}).get("checked")
        ref = max(datetime.fromisoformat(prev), since) if prev else since
        if n >= 20 and oldest > ref:
            notes.append(f"机器之心接口一次只给最近 20 篇，本地时间 {fmt_time(ref)} 到 {fmt_time(oldest)} 之间发的可能没取到")
    except Exception as e:
        failures.append(f"机器之心（{errtext(e)}）")

    days, cut = hf_days(view.get("hf"), now)
    truncated |= cut
    if days:
        got, done, err = fetch_hf(days)
        new += [x for x in got if x["key"] not in seen]
        if done:
            updates["hf"] = {"last_date": done.isoformat()}
            span["hf"] = [d.isoformat() for d in days if d <= done]
        if err:
            failures.append(f"HF 每日论文 {(done + timedelta(days=1)) if done else days[0]:%m-%d} 起（{errtext(err)}）")
    if truncated:
        notes.append("离上次抓取超过 3 天，只补了最近 3 天")
    return new, updates, failures, notes, span


def merge_span(*spans):
    """几次抓取的覆盖范围合起来：AINews、机器之心取最早的起点，HF 取查过的日期的并集。"""
    out = {}
    for sp in spans:
        for src, v in (sp or {}).items():
            if src == "hf":
                out["hf"] = sorted(set(out.get("hf", [])) | set(v))
            elif src not in out or datetime.fromisoformat(v) < datetime.fromisoformat(out[src]):
                out[src] = v
    return out


def cov_text(span):
    l, j = (fmt_time(datetime.fromisoformat(span[k])) if span.get(k) else None for k in ("ainews", "jiqizhixin"))
    if l and l == j:
        parts = [f"AINews、机器之心取本地时间 {l} 之后发布的"]
    else:
        parts = [f"{n}取本地时间 {t} 之后发布的" for n, t in (("AINews", l), ("机器之心", j)) if t]
    if span.get("hf"):
        parts.append(f"HF 查了 {'、'.join(d[5:] for d in span['hf'])} 的榜单，收过的不重复")
    return "；".join(parts) or "三个来源都没抓到"


def attr(s):
    return re.sub(r"\s+", " ", str(s)).replace('"', "'").strip()


def build_material(items):
    """按来源编号拼材料：L、J 按发布时间，H 按点赞从高到低。返回 (材料, 编号→[链接文字, 网址], keys, 各来源条数)。"""
    L = sorted((x for x in items if x["src"] == "ainews"), key=lambda x: x["time"])
    J = sorted((x for x in items if x["src"] == "jiqizhixin"), key=lambda x: x["time"])
    H = sorted((x for x in items if x["src"] == "hf"), key=lambda x: (-x["upvotes"], x["pid"]))
    links, parts = {}, []
    for i, it in enumerate(L, 1):
        k = f"L{i}"
        links[k] = [f"AINews {fmt_time(it['time'])[:5]}", it["url"]]
        parts.append(f'<条目 编号="{k}" 来源="Latent Space AINews" 发布="{fmt_time(it["time"])}" 标题="{attr(it["title"])}">\n{it["body"]}\n</条目>')
    for i, it in enumerate(J, 1):
        k = f"J{i}"
        links[k] = ["机器之心", it["url"]]
        parts.append(f'<条目 编号="{k}" 来源="机器之心" 发布="{fmt_time(it["time"])}" 标题="{attr(it["title"])}" 标签="{attr("、".join(it["tags"]))}">\n'
                     f'开头摘录：{it["body"]}\n</条目>')
    shorten = sum(len(x["body"]) for x in H) > HF_ABSTRACT_BUDGET
    for i, it in enumerate(H, 1):
        k = f"H{i}"
        links[k] = [f"HF {it['pid']}", it["url"]]
        abstract = it["body"]
        if shorten and len(abstract) > HF_ABSTRACT_SHORT:
            abstract = abstract[:HF_ABSTRACT_SHORT].rstrip() + "……"
        lines = [f"一句话：{it['one_line']}" if it["one_line"] else "", f"摘要：{abstract}", "代码：已开源" if it["code"] else ""]
        parts.append(f'<条目 编号="{k}" 来源="HF 每日论文 {it["day"]:%m-%d}" 点赞="{it["upvotes"]}" 标题="{attr(it["title"])}" '
                     f'关键词="{attr(", ".join(it["keywords"]))}">\n' + "\n".join(x for x in lines if x) + "\n</条目>")
    material = "<材料>\n\n" + "\n\n".join(parts) + "\n\n</材料>"
    return material, links, [x["key"] for x in L + J + H], {"L": len(L), "J": len(J), "H": len(H)}


def run_proc(args, prompt, stdin_file, outf, errf, timeout, **kw):
    """提示词先写成文件当 stdin：用管道的话，子进程不读 stdin 时 Windows 上写管道这一步就卡住，等不到超时检查。
    返回 (退出码, 是否超时, 超时后进程是否还活着)；写文件、启动出错时抛 OSError，调用方按报错处理。"""
    try:
        stdin_file.write_bytes(prompt.encode("utf-8"))
        with open(stdin_file, "rb") as inp, open(outf, "wb") as out, open(errf, "wb") as err:
            if os.name != "nt":
                kw.setdefault("start_new_session", True)
            p = subprocess.Popen(args, stdin=inp, stdout=out, stderr=err, **kw)
            try:
                p.wait(timeout=timeout)
                return p.returncode, False, False
            except subprocess.TimeoutExpired:
                return p.returncode, True, not stop_tree(p)
    finally:
        try:
            stdin_file.unlink(missing_ok=True)
        except OSError:
            pass


def slurp(path):
    """读子进程的输出文件；读不了当空的。"""
    try:
        return path.read_text("utf-8", errors="replace")
    except OSError:
        return ""


def launch_failed(model, effort, msg, t0, acct=None):
    """没跑起来（找不到程序、写不了文件）：输出文件不去读，按报错交给下一个。"""
    secs = time.time() - t0
    r = {"status": "error", "text": "", "error": msg, "usage_text": f"没跑起来  {secs:.0f}s", "secs": secs, "model": model, "effort": effort}
    if acct:
        r["acct"] = acct
    return r


def left():
    """这次运行还剩几秒。"""
    return float("inf") if DEADLINE is None else DEADLINE - time.time()


def run_claude(prompt, run_dir, acct, timeout=None):
    model, timeout = CLAUDE_MODEL, timeout or CLAUDE_TIMEOUT
    reply = run_dir / f"reply-{model}.md"
    outf = run_dir / f"claude-{model}-{acct}.json"
    errf = run_dir / f"claude-{model}-{acct}.stderr.txt"


    command = cli_command("claude")
    args = [*(command or []), "-p", "--model", model, "--effort", CLAUDE_EFFORT, "--safe-mode",
            "--setting-sources", "", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
            "--output-format", "json", "--system-prompt", CLAUDE_SYSTEM]
    t0 = time.time()
    try:
        if not command:
            raise OSError("PATH 中没有可用的 Claude CLI")
        settings = check_account_settings(acct)
        if settings is not None:
            args.extend(["--settings", str(settings)])
        for f in (reply, outf, errf):
            f.unlink(missing_ok=True)
        rc, timed_out, stuck = run_proc(args, prompt, run_dir / f"stdin-{model}-{acct}.md", outf, errf, timeout,
                                        cwd=str(run_dir), env=claude_env(acct))
    except (OSError, ValueError) as e:
        return launch_failed(model, CLAUDE_EFFORT, f"启动不了 Claude Code（{errtext(e)}）", t0, acct)
    raw = slurp(outf)
    stderr = slurp(errf).strip()
    try:
        res = json.loads(raw)
    except ValueError:
        res = None
    res = res if isinstance(res, dict) else {}
    text = res.get("result") if isinstance(res.get("result"), str) else ""
    text = text.strip()
    if text:
        atomic_write(reply, text + "\n")
    cost = res.get("total_cost_usd")
    u = res.get("usage") if isinstance(res.get("usage"), dict) else {}
    n = lambda k: int(u.get(k) or 0)
    think = int((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0)
    secs = time.time() - t0

    spent = f"${cost:.2f}" if isinstance(cost, (int, float)) else "折算费用未知"
    usage = (f"in={n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')} cached={n('cache_read_input_tokens')} "
             f"out={n('output_tokens')}（思考 {think}） {spent}  {secs:.0f}s")
    fail = ""
    if timed_out:
        status, fail = "timeout", f"{timeout / 60:.0f} 分钟没跑完，" + ("进程没能结束" if stuck else "已结束进程")
    elif rc == 0 and not res.get("is_error") and res.get("stop_reason") != "max_tokens" and HEAD_RE.search(text):
        status = "ok"
    elif rc == 0 and res and not res.get("is_error"):
        status = "error"
        fail = "输出到上限被截断了" if res.get("stop_reason") == "max_tokens" else (
            "回复没按格式写（没有“## 今天最值得看”），开头是：" + re.sub(r"\s+", " ", text[:200]) if text else "没有回复")
    else:
        lines = [x.strip() for x in stderr.splitlines() if x.strip()]
        fail = (text if res.get("is_error") else "") or " | ".join(lines[-3:]) or raw.strip()[:300] or f"exit={rc}，没有输出"
        if res.get("api_error_status"):
            fail = f"API {res['api_error_status']}：{fail}"
        both = f"{fail} {stderr} {raw[:2000] if not res else ''}"
        if re.search(r"hit your .*limit|usage limit|limit reached", both, re.I):
            status = "limit"
        elif re.search(r"/login|log ?in again|not logged in|authenticat|unauthori[sz]ed|\b401\b|oauth token|invalid api key", both, re.I):
            status = "auth"
        else:
            status = "error"
    return {"status": status, "text": text, "error": re.sub(r"\s+", " ", fail).strip(), "usage_text": usage, "secs": secs,
            "model": model, "effort": CLAUDE_EFFORT, "acct": acct}


def run_codex(prompt, run_dir, model, timeout=None):
    timeout = timeout or CODEX_TIMEOUT
    reply = run_dir / f"reply-{model}.md"
    events = run_dir / f"codex-{model}.jsonl"
    errf = run_dir / f"codex-{model}.stderr.txt"


    command = cli_command("codex")
    args = [*(command or []), "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
            "--ignore-rules", "-s", "read-only", "-C", str(run_dir), "-m", model,
            "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"',
            "-c", f'model_reasoning_effort="{EFFORT}"', "-c", 'web_search="disabled"',
            "-c", 'approval_policy="never"', "-o", str(reply), "-"]
    t0 = time.time()
    try:
        if not command:
            raise OSError("PATH 中没有可用的 Codex CLI")
        for f in (reply, events, errf):
            f.unlink(missing_ok=True)
        rc, timed_out, stuck = run_proc(args, prompt, run_dir / f"stdin-{model}.md", events, errf, timeout, env=codex_env(), cwd=str(run_dir))
    except OSError as e:
        return launch_failed(model, EFFORT, f"启动不了 Codex（{errtext(e)}）", t0)
    usage, fail = None, ""
    for line in slurp(events).splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "turn.completed":
            usage = ev.get("usage")
        elif ev.get("type") in ("turn.failed", "error"):
            e = ev.get("error")
            fail = (e.get("message") if isinstance(e, dict) else None) or ev.get("message") or json.dumps(ev, ensure_ascii=False)
    stderr = slurp(errf)
    if not fail:
        lines = [x.strip() for x in stderr.splitlines() if x.strip()]
        errs = [x for x in lines if "error" in x.lower()]
        fail = errs[-1] if errs else " | ".join(lines[-3:])
    fail = re.sub(r"\s+", " ", str(fail)).strip()
    text = slurp(reply).strip()
    both = fail + " " + stderr
    if timed_out:
        status, fail = "timeout", fail or f"{timeout / 60:.0f} 分钟没跑完，" + ("进程没能结束" if stuck else "已结束进程")
    elif rc == 0 and HEAD_RE.search(text):
        status = "ok"
    elif re.search(r"at capacity", both, re.I):
        status = "capacity"
    elif re.search(r"usage limit|hit your .*limit", both, re.I):
        status = "limit"
    else:
        status = "error"
        if rc == 0 and text and not fail:
            fail = "回复没按格式写（没有“## 今天最值得看”），开头是：" + re.sub(r"\s+", " ", text[:200])
    if status != "ok" and not fail:
        fail = f"exit={rc}，回复 {len(text)} 字"
    u, secs = usage or {}, time.time() - t0
    usage_text = f"in={u.get('input_tokens', 0)} cached={u.get('cached_input_tokens', 0)} out={u.get('output_tokens', 0)}  {secs:.0f}s"
    return {"status": status, "text": text, "error": fail, "usage_text": usage_text, "secs": secs, "model": model, "effort": EFFORT}


HEAD_RE = re.compile(r"^##\s*今天最值得看", re.M)


REQUIRED_SECTIONS = ("今天最值得看", "后训练", "推荐", "Agent")


ID_ANY = re.compile(r"[\[【]\s*[LJH]\d+(?:\s*[,，、;；/]\s*[LJH]\d+)*\s*[\]】]")


ID_GROUP = re.compile(r"[\[【]\s*([LJH]\d+(?:\s*[,，、;；/]\s*[LJH]\d+)*)\s*[\]】](?!\()")


ID_PAIR = re.compile(r"([\[【]\s*[LJH]\d+(?:\s*[,，、;；/]\s*[LJH]\d+)*)\s*[\]】][ \t]*[\[【]\s*([LJH]\d+)"
                     r"(?=(?:\s*[,，、;；/]\s*[LJH]\d+)*\s*[\]】](?!\())")


LIST_SECTIONS = ("今天最值得看", "模型发布", "其他相关")


CANON_SECTIONS = REQUIRED_SECTIONS + ("模型发布", "其他相关")


EMPTY_SECTIONS = ("模型发布", "后训练", "推荐", "Agent")


def canon_heads(text):
    """二级标题统一成提示词里的写法：去掉结尾冒号，“推荐系统”“Agent 与工具”这类归到对应栏目，后面按栏目名校验和配色。"""
    def fix(m):
        t = m.group(1).strip().rstrip(":：").strip()
        for c in CANON_SECTIONS:
            if t.lower().startswith(c.lower()):
                return "## " + c
        return "## " + t
    return re.sub(r"(?m)^##[ \t]*(?!#)(.+?)[ \t]*$", fix, text)


def bulletize(text):
    """模型有时把骨架里的“- ”连同说明一起替换掉，或换成 * 和 1.；列表栏目里的行统一成“- ”开头，免得渲染成一整段。"""
    out, sec = [], ""
    for line in text.split("\n"):
        h = re.match(r"^##\s*([^#].*?)\s*$", line)
        if h:
            sec = h.group(1)
        elif sec in LIST_SECTIONS and line.strip():
            m = re.match(r"^\s*(?:[-*+]|\d+[.)、])\s*(.*)$", line)
            item = m.group(1) if m else line.strip()

            line = item if sec != "今天最值得看" and item.rstrip("。.") == "今天没有" else "- " + item
        out.append(line)
    return "\n".join(out)


def finalize_body(text, links):
    text = text.strip()
    m = re.match(r"^```[A-Za-z]*\n(.*)\n```$", text, re.S)
    if m:
        text = m.group(1).strip()
    m = HEAD_RE.search(text)
    if m:
        text = text[m.start():]

    text = re.sub(r"!\[\[[^\]]*\]\]", "", text)
    text = re.sub(r"!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?", "", text)
    text = re.sub(r"<img\b[^>]*>", "", text, flags=re.I)
    text = ID_ANY.sub(lambda m: re.sub(r"\s+", " ", m.group(0)), text)
    text = bulletize(canon_heads(text))

    prev = None
    while prev != text:
        prev = text
        text = ID_PAIR.sub(r"\1, \2", text)
    used, unknown = set(), set()

    def repl(m):
        out = []
        for k in re.split(r"\s*[,，、;；/]\s*", m.group(1)):
            if k in links:
                used.add(k)
                out.append(f"[{links[k][0]}]({links[k][1]})")
            else:
                unknown.add(k)
                out.append(f"[{k}]")
        return " · ".join(out)

    return ID_GROUP.sub(repl, text), sorted(unknown), used


def reply_problem(body, unknown, used):
    """回复能不能当成简报落盘。不能的返回原因，按失败处理、材料留在 pending，免得一份空壳把整批条目记成已见。"""
    heads = {h.strip() for h in re.findall(r"(?m)^##[ \t]*(?!#)(.+?)[ \t]*$", body)}
    missing = [h for h in REQUIRED_SECTIONS if h not in heads]
    if missing:
        return "回复缺栏目：" + "、".join(missing)
    hot = re.search(r"(?ms)^##[ \t]*今天最值得看[ \t]*$(.*?)(?=^##[ \t]*(?!#)|\Z)", body)
    if not hot or not re.search(r"(?m)^- \S", hot.group(1)):
        return "“今天最值得看”下面没有内容"
    if unknown:
        return "回复里有材料中没有的来源编号：" + "、".join(unknown)
    if not used:
        return "回复没有引用任何来源编号"
    return ""


def footer(meta, made):
    """made 是“模型（档位）”加说明；None 表示没调模型。"""
    c = meta["counts"]
    lines = [f"材料：AINews {c['L']} 期、机器之心 {c['J']} 篇、HF 每日论文 {c['H']} 篇", f"时段：{meta['coverage']}"]
    lines += [f"抓取失败：{x}，这部分下次补上" for x in meta["failures"]]
    lines += meta.get("notes") or []
    lines.append(f"生成：{made or '没有新材料，没调模型'}，本地时间 {now_local():%m-%d %H:%M}")
    return "\n".join(f"- {x}" for x in lines)


def note_head(day):
    """输出目录中那天简报属性里的 status 和 batch；没有简报返回 None。"""
    try:
        text = note_path(day).read_text("utf-8", errors="replace").replace("\r\n", "\n")
    except FileNotFoundError:
        return None
    m = re.match(r"---\n(.*?)\n---[ \t]*\n", text, re.S)
    fm = dict(re.findall(r"(?m)^(status|batch):[ \t]*['\"]?([A-Za-z0-9]+)", m.group(1) if m else ""))
    return {"status": fm.get("status", "unknown").lower(), "batch": fm.get("batch")}


def note_status(day):
    h = note_head(day)
    return h and h["status"]


STATUS_ZH = {"limit": "撞限", "auth": "登录失效", "error": "报错", "timeout": "超时", "bad-reply": "回复不合格", "capacity": "满载",
             "no-time": "没时间了"}


def who(r):
    """“模型 A 号”这样的说法，日志和失败简报里用。"""
    return f"{r['model']} {r['acct'].upper()} 号" if r.get("acct") else r["model"]


def no_time(model):
    return {"status": "no-time", "text": "", "error": f"这次运行只剩 {max(left(), 0) / 60:.0f} 分钟，不够再调模型", "usage_text": "",
            "secs": 0, "model": model, "effort": ""}


IMG_EXT = re.compile(r"\.(png|jpe?g|gif|webp)$", re.I)


FIG_FILE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|svg)$", re.I)


FIG_SECTIONS = ("模型发布", "后训练", "推荐", "Agent")


CAP_STRONG = re.compile(r"\b(accuracy|performance|results?|benchmarks?|scores?|win[- ]?rates?|pass@\w*|outperform\w*|success[- ]rates?|elo|"
                        r"speed-?ups?|latency|throughput|scaling|ablations?|pareto|trade-?offs?|budgets?|gains?|improvements?)\b", re.I)


CAP_WEAK = re.compile(r"\b(compar\w*|vs|versus|across)\b", re.I)


CAP_NEG = re.compile(r"\b(overview|architectures?|pipelines?|framework|illustrat\w*|examples?|cases?|qualitative|demonstrations?|"
                     r"schematic|workflow|templates?|screenshots?)\b", re.I)


ARXIV_MAX = 15


class _Figures(HTMLParser):
    """arXiv HTML 版的 <figure>：[{"cap": 图注, "imgs": [(地址, 子图注)]}]，子图并进外层。作者单位 logo 这类不在 figure 里，不收。
    图有三种写法：<img> 位图、<object data="x1.svg"> 引用的 SVG 文件（PDF 图转的）、直接内嵌的 <svg>（TikZ 画的）；
    前两种有地址能引用，内嵌的拿不出来，不收。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.figs, self.stack, self.cap, self.skip = [], [], None, 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("annotation", "annotation-xml"):
            self.skip += 1
        elif tag == "figure":
            self.stack.append({"cap": "", "imgs": [], "table": "ltx_table" in (a.get("class") or "").split()})
        elif tag in ("img", "object") and self.stack:
            src = a.get("src") if tag == "img" else a.get("data")
            w = re.match(r"\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*%)", str(a.get("width") or ""))
            if src and (tag == "img" or FIG_FILE_EXT.search(src.split("?")[0])) and not (w and float(w.group(1)) < 100):
                if src not in (x[0] for x in self.stack[-1]["imgs"]):
                    self.stack[-1]["imgs"].append([src, ""])
        elif tag == "figcaption" and self.stack:
            self.cap = []

    def handle_endtag(self, tag):
        if tag in ("annotation", "annotation-xml"):
            self.skip = max(0, self.skip - 1)
        elif tag == "figcaption" and self.cap is not None and self.stack:
            self.stack[-1]["cap"] = re.sub(r"\s+([:.,;)])", r"\1", re.sub(r"\s+", " ", "".join(self.cap))).strip()
            self.cap = None
        elif tag == "figure" and self.stack:
            f = self.stack.pop()
            if f["table"]:
                return
            if self.stack:
                outer = self.stack[-1]
                outer["imgs"] += [[src, sub or f["cap"]] for src, sub in f["imgs"]]
            elif f["imgs"]:
                self.figs.append(f)

    def handle_data(self, data):
        if self.cap is not None and not self.skip:
            self.cap.append(data)


def fetch_page(url, timeout=30):
    raw, final = bounded(lambda: http_once(url, timeout), min(2 * timeout, left() - WRAP_RESERVE))
    return raw.decode("utf-8", "replace"), final


def cap_score(text):
    return 3 * bool(CAP_STRONG.search(text)) + bool(CAP_WEAK.search(text)) - 2 * bool(CAP_NEG.search(text))


def arxiv_figure(pid):
    """前 12 张图里按图注打分挑一张（见 CAP_STRONG 那几行），同分取靠前的；子图里图注像评测结果的优先。
    没有 HTML 版（404）或没有能引用的图返回 None。"""
    try:
        page, final = fetch_page(f"https://arxiv.org/html/{pid}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    p = _Figures()
    p.feed(page)
    p.close()
    figs = p.figs[:12]
    if not figs:
        return None
    f = max(figs, key=lambda x: cap_score(x["cap"] + " " + " ".join(s for _, s in x["imgs"])) + (x is figs[0]))
    src, sub = max(f["imgs"], key=lambda x: cap_score(x[1]))
    cap = f["cap"] if not sub or sub == f["cap"] else f"{sub} {f['cap']}"
    return {"src": urljoin(final, htmllib.unescape(src)), "cap": cap[:300], "page": final}


def section_texts(body, names):
    parts = re.split(r"(?m)^##[ \t]*(?!#)(.+?)[ \t]*$", body)
    return [(t.strip(), c) for t, c in zip(parts[1::2], parts[2::2]) if t.strip() in names]


def gather_figures(body, run_dir):
    path = SITE_DIR / "figures.json"
    figs = read_json(path) or {}
    items = {x.get("url"): x for x in dec_items(read_json(run_dir / "items.json"))}
    urls = [u for _, c in section_texts(body, FIG_SECTIONS) for u in re.findall(r"\]\((https?://[^)\s]+)\)", c)]
    looked, added = 0, 0
    for url in dict.fromkeys(urls):
        if url in figs:
            continue
        it = items.get(url) or {}
        if url.startswith("https://huggingface.co/papers/"):
            if it.get("media"):
                fig = {"src": it["media"], "cap": "", "page": url}
            else:

                if looked >= ARXIV_MAX or left() < WRAP_RESERVE + 3 + 60:
                    continue
                if looked:
                    time.sleep(3)
                looked += 1
                try:
                    fig = arxiv_figure(url.rsplit("/", 1)[-1])
                except Exception as e:
                    log(f"配图没取到：{url}（{errtext(e)}）")
                    continue
        else:
            continue
        figs[url] = fig or {}
        added += bool(fig)
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(path, dump(figs))
    if added or looked:
        log(f"配图：新配 {added} 张，查了 arXiv {looked} 篇")


CAT_CLASS = {"模型发布": "c-model", "后训练": "c-post", "推荐": "c-rec", "Agent": "c-agent", "其他相关": "c-other"}


WEEKDAY = "一二三四五六日"


SITE_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AI 简报 · {date}</title>
<link rel="stylesheet" href="style.css">
</head>
<body data-date="{date}">
<div class="layout">
<nav id="days"></nav>
<main>
<header class="top">
<div><h1>{date}<span class="wd">周{wd}</span></h1><div class="sub">{sub}</div></div>
<div class="pager" id="pager"></div>
</header>
{content}
</main>
</div>
<script src="days.js"></script>
<script src="site.js"></script>
</body>
</html>
"""


SITE_INDEX = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>AI 简报</title><link rel="stylesheet" href="style.css"></head>
<body>
<p class="empty">还没有简报。</p>
<script src="days.js"></script>
<script>
var d = window.BRIEFING_DAYS || [];
if (d.length) location.replace(d[0].date + ".html");
</script>
</body>
</html>
"""


SITE_JS = r"""// 左侧日期栏和前后翻页。日期清单在 days.js（每次生成简报时重写），页面本身不用跟着改。
(function () {
  var days = window.BRIEFING_DAYS || [];
  var cur = document.body.getAttribute("data-date");
  var nav = document.getElementById("days");
  var pager = document.getElementById("pager");
  if (!nav) return;
  var TAGS = { failed: "没生成", partial: "缺来源" };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  };
  var months = [], byMonth = {};
  days.forEach(function (d) {
    var m = d.date.slice(0, 7);
    if (!byMonth[m]) { byMonth[m] = []; months.push(m); }
    byMonth[m].push(d);
  });
  var h = '<a class="brand" href="index.html">AI 简报</a>';
  months.forEach(function (m, i) {
    var open = cur ? cur.slice(0, 7) === m : i === 0;
    h += "<details" + (open ? " open" : "") + "><summary>" + esc(m.slice(0, 4)) + " 年 " + esc(String(+m.slice(5))) + " 月</summary><ul>";
    byMonth[m].forEach(function (d) {
      var tag = TAGS[d.status];
      var cls = (d.date === cur ? "cur" : "") + (tag ? " " + d.status : "");
      h += '<li class="' + cls + '"><a href="' + esc(d.date) + '.html"><span>' + esc(d.label) + "</span>" +
        (tag ? '<span class="tag">' + tag + "</span>" : "") + "</a></li>";
    });
    h += "</ul></details>";
  });
  nav.innerHTML = h;
  if (pager && cur) {
    var i = days.map(function (d) { return d.date; }).indexOf(cur), p = "";
    if (i >= 0 && i + 1 < days.length) p += '<a href="' + esc(days[i + 1].date) + '.html">← ' + esc(days[i + 1].label) + "</a>";
    if (i > 0) p += '<a href="' + esc(days[i - 1].date) + '.html">' + esc(days[i - 1].label) + " →</a>";
    pager.innerHTML = p;
  }
})();
"""


SITE_CSS = """/* 每日 AI 简报网页版。配色取 Catppuccin（浅色 Latte、深色 Mocha），跟随系统切换 */
:root {
  --bg: #eff1f5; --panel: #ffffff; --text: #4c4f69; --sub: #5c5f77; --muted: #8c8fa1;
  --line: #dce0e8; --chip: #e6e9ef; --chip-text: #5c5f77; --link: #1e66f5;
  --hot: #df8e1d; --model: #ea76cb; --post: #8839ef; --rec: #fe640b; --agent: #1e66f5; --other: #40a02b; --bad: #d20f39;
  --shadow: 0 1px 2px rgba(76, 79, 105, .05), 0 6px 20px rgba(76, 79, 105, .06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #11111b; --panel: #1e1e2e; --text: #cdd6f4; --sub: #bac2de; --muted: #7f849c;
    --line: #313244; --chip: #313244; --chip-text: #cdd6f4; --link: #89b4fa;
    --hot: #f9e2af; --model: #f5c2e7; --post: #cba6f7; --rec: #fab387; --agent: #89b4fa; --other: #a6e3a1; --bad: #f38ba8;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.8 -apple-system, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
.layout { display: grid; grid-template-columns: 180px minmax(0, 760px); gap: 44px; justify-content: center; padding: 36px 24px 72px; }
nav#days { position: sticky; top: 28px; align-self: start; max-height: calc(100vh - 56px); overflow-y: auto; font-size: 14px; line-height: 1.6; }
nav#days .brand { display: block; margin: 2px 0 16px; font-size: 18px; font-weight: 700; letter-spacing: .04em; color: var(--text); }
nav#days .brand:hover { text-decoration: none; }
nav#days details { margin-bottom: 12px; }
nav#days summary { cursor: pointer; margin-bottom: 4px; font-size: 13px; color: var(--muted); }
nav#days ul { list-style: none; margin: 0; padding: 0; }
nav#days li a { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 10px; border-radius: 8px; color: var(--sub); }
nav#days li a:hover { background: var(--chip); text-decoration: none; }
nav#days li.cur a { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
nav#days li.failed a { color: var(--bad); }
nav#days li.partial .tag { color: var(--hot); }
nav#days .tag { font-size: 11px; }
main { min-width: 0; }
.top { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 26px; }
.top h1 { margin: 0; font-size: 30px; line-height: 1.3; font-weight: 700; }
.top h1 .wd { margin-left: 12px; font-size: 18px; font-weight: 500; color: var(--muted); }
.top .sub { margin-top: 4px; font-size: 14px; color: var(--muted); }
.pager { display: flex; gap: 16px; font-size: 14px; }
.pager a { color: var(--sub); }
.hot { margin-bottom: 32px; padding: 16px 22px 14px; background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--hot); border-radius: 14px; box-shadow: var(--shadow); }
.hot h2 { margin: 0 0 6px; font-size: 14px; font-weight: 700; letter-spacing: .12em; color: var(--hot); }
.hot ul, .hot p { margin: 0; }
.hot ul { padding-left: 1.1em; }
.hot li { margin: 4px 0; }
section.cat { --accent: var(--muted); margin: 36px 0; }
section.c-model { --accent: var(--model); }
section.c-post { --accent: var(--post); }
section.c-rec { --accent: var(--rec); }
section.c-agent { --accent: var(--agent); }
section.c-other { --accent: var(--other); }
section.cat > h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; font-size: 20px; }
section.cat > h2::before { content: ""; width: 12px; height: 12px; border-radius: 4px; background: var(--accent); }
.none { color: var(--muted); }
.none p { margin: 0; }
.card { position: relative; overflow: hidden; margin: 14px 0; padding: 16px 22px 14px 26px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--accent); }
.card h3 { margin: 0 0 6px; font-size: 17px; line-height: 1.55; }
.card p { margin: 0; color: var(--sub); }
.card a, .hot a, .c-other a {
  display: inline-block; margin: 0 2px; padding: 0 9px; border-radius: 999px; background: var(--chip); color: var(--chip-text);
  font-size: 12px; line-height: 1.75; vertical-align: 1px; white-space: nowrap;
}
.card a:hover, .hot a:hover, .c-other a:hover { text-decoration: none; filter: brightness(.94); }
.c-other ul { margin: 0; padding-left: 1.1em; }
.c-other li { margin: 6px 0; color: var(--sub); }
.card.rel { padding-top: 12px; }
/* 配图：原图多是白底的图表，深色模式下也垫白底；点开是原文页 */
.card figure.fig { margin: 12px 0 2px; }
.card figure.fig a { display: block; margin: 0; padding: 8px; border-radius: 10px; background: #fff; border: 1px solid var(--line);
  line-height: 0; white-space: normal; }
.card figure.fig a:hover { filter: none; }
.card figure.fig img { display: block; width: 100%; max-height: 420px; object-fit: contain; }
.card figure.fig figcaption { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
footer.meta { margin-top: 44px; padding-top: 14px; border-top: 1px dashed var(--line); font-size: 13px; line-height: 1.7; color: var(--muted); }
footer.meta ul { margin: 0; padding-left: 1.1em; }
.failed-box { padding: 16px 22px; background: var(--panel); border: 1px solid var(--bad); border-radius: 14px; }
.plain { margin-bottom: 20px; }
pre { padding: 10px 14px; background: var(--chip); border-radius: 10px; overflow-x: auto; font-size: 13px; line-height: 1.6; }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: .9em; }
.empty { margin-top: 20vh; text-align: center; color: var(--muted); }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 20px 16px 56px; }
  nav#days { position: static; max-height: none; }
  nav#days details:not([open]) { display: none; }
}
"""


def md_inline(s):
    s = htmllib.escape(s)
    codes = []

    def keep(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    s = re.sub(r"`([^`]+)`", keep, s)
    def link(m):
        url = htmllib.unescape(m.group(2))
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
            return m.group(1)
        return f'<a href="{m.group(2)}" target="_blank" rel="noopener">{m.group(1)}</a>'

    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{codes[int(m.group(1))]}</code>", s)


def md_blocks(md):
    """段落、- 和 1. 列表、``` 代码块、--- 分隔线、标题。段内单个换行显示成换行。"""
    out, para, items, tag, code = [], [], [], None, None

    def flush():
        nonlocal para, items, tag
        if para:
            out.append("<p>" + "<br>".join(para) + "</p>")
            para = []
        if items:
            out.append(f"<{tag}>" + "".join(f"<li>{x}</li>" for x in items) + f"</{tag}>")
            items, tag = [], None

    for line in md.split("\n"):
        if code is not None:
            if line.strip().startswith("```"):
                out.append("<pre><code>" + htmllib.escape("\n".join(code)) + "</code></pre>")
                code = None
            else:
                code.append(line)
            continue
        if line.strip().startswith("```"):
            flush()
            code = []
            continue
        m = re.match(r"^(#{1,6})\s*(.+?)\s*$", line)
        if m:
            flush()
            n = len(m.group(1))
            out.append(f"<h{n}>{md_inline(m.group(2))}</h{n}>")
            continue
        if re.match(r"^\s*-{3,}\s*$", line):
            flush()
            out.append("<hr>")
            continue
        m = re.match(r"^\s*(?:([-*+])|\d+[.)、])\s+(.*)$", line)
        if m:
            t = "ul" if m.group(1) else "ol"
            if para or (tag and tag != t):
                flush()
            tag = t
            items.append(md_inline(m.group(2)))
            continue
        if not line.strip():
            flush()
            continue
        if items:
            flush()
        para.append(md_inline(line.strip()))
    if code is not None:
        out.append("<pre><code>" + htmllib.escape("\n".join(code)) + "</code></pre>")
    flush()
    return "\n".join(out)


def split_note(md):
    """返回 (frontmatter, 正文, 页脚)。页脚是最后一个单独成行的 --- 之后的部分。"""
    md = md.replace("\r\n", "\n")
    fm = {}
    if md.startswith("---\n"):
        end = md.find("\n---\n", 4)
        if end > 0:
            for line in md[4:end].splitlines():
                if ":" in line and not line.startswith((" ", "\t", "-")):
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip().strip("'\"")
            md = md[end + 5:]
    md = re.sub(r"(?m)^\[网页版\]\([^)]*\)[ \t]*\n?", "", md)
    seps = list(re.finditer(r"(?m)^---[ \t]*$", md))
    if seps:
        return fm, md[:seps[-1].start()], md[seps[-1].end():]
    return fm, md, ""


LIST_RE = re.compile(r"(?m)^\s*(?:[-*+]|\d+[.)、])\s+(.*)$")


def fig_html(md, figs):
    """条目里第一个配了图的来源链接，出那张图；图挂了（原图删了、打不开）就整块去掉。"""
    for url in re.findall(r"\]\((https?://[^)\s]+)\)", md):
        f = figs.get(url) or {}
        if f.get("src"):
            cap = f"<figcaption>{htmllib.escape(f['cap'])}</figcaption>" if f.get("cap") else ""
            return (f'<figure class="fig"><a href="{htmllib.escape(f.get("page") or f["src"])}" target="_blank" rel="noopener">'
                    f'<img src="{htmllib.escape(f["src"])}" alt="" loading="lazy" referrerpolicy="no-referrer" '
                    f"""onerror="this.closest('figure').remove()"></a>{cap}</figure>""")
    return ""


def render_note(md, figs=None):
    figs = figs or {}
    fm, main, foot = split_note(md)
    parts = re.split(r"(?m)^##[ \t]*(?!#)(.+?)[ \t]*$", main)
    out, counts = [], {}
    if parts[0].strip():
        box = "failed-box" if fm.get("status") == "failed" else "plain"
        out.append(f'<div class="{box}">{md_blocks(parts[0])}</div>')
    for title, content in zip(parts[1::2], parts[2::2]):
        title = title.strip()
        if title == "今天最值得看":
            out.append(f'<section class="hot"><h2>今天最值得看</h2>{md_blocks(content)}</section>')
            continue
        head = f'<section class="cat {CAT_CLASS.get(title, "")}"><h2>{htmllib.escape(title)}</h2>'
        pieces = re.split(r"(?m)^###[ \t]*(.+?)[ \t]*$", content)
        if title == "模型发布" and len(pieces) == 1 and LIST_RE.search(content):
            rows = LIST_RE.findall(content)
            counts[title] = len(rows)
            out.append(head + "".join(f'<article class="card rel"><p>{md_inline(t)}</p>{fig_html(t, figs)}</article>' for t in rows) + "</section>")
            continue
        lead = md_blocks(pieces[0]) if pieces[0].strip() else ""
        if lead and len(pieces) == 1 and not LIST_RE.search(pieces[0]):
            lead = f'<div class="none">{lead}</div>'
        cards = "".join(f'<article class="card"><h3>{md_inline(t)}</h3>{md_blocks(c)}{fig_html(c, figs)}</article>'
                        for t, c in zip(pieces[1::2], pieces[2::2]))
        counts[title] = len(pieces) // 2 or len(LIST_RE.findall(content))
        out.append(f"{head}{lead}{cards}</section>")
    if foot.strip():
        out.append(f'<footer class="meta">{md_blocks(foot)}</footer>')
    return fm, "\n".join(out), counts


def put(path, text):
    """内容没变就不重写，减少不必要的文件改写。"""
    try:
        if path.read_text("utf-8") == text:
            return
    except FileNotFoundError:
        pass
    path.write_text(text, "utf-8", newline="\n")


def build_site():
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    put(SITE_DIR / "style.css", SITE_CSS)
    put(SITE_DIR / "site.js", SITE_JS)
    put(SITE_DIR / "index.html", SITE_INDEX)
    notes = []
    for p in OUTPUT_DIR.glob("*/*.md"):
        try:
            notes.append((date.fromisoformat(p.stem), p))
        except ValueError:
            continue
    notes.sort(key=lambda x: x[0], reverse=True)
    fig_file = SITE_DIR / "figures.json"
    figs = read_json(fig_file) or {}
    days, linked = [], set()
    for d, p in notes:
        md = p.read_text("utf-8", errors="replace")
        linked.update(re.findall(r"\]\((https?://[^)\s]+)\)", md))
        fm, content, counts = render_note(md, figs)
        status = fm.get("status", "unknown").lower()
        if status == "failed":
            sub = "这天的简报没生成"
        else:
            sub = " · ".join(f"{k} {counts[k]}" for k in ("模型发布", "后训练", "推荐", "Agent", "其他相关") if k in counts)
            if status == "partial":
                sub = " · ".join(x for x in (sub, "有来源没抓到") if x)
        put(SITE_DIR / f"{d:%Y-%m-%d}.html", SITE_PAGE.format(date=f"{d:%Y-%m-%d}", wd=WEEKDAY[d.weekday()], sub=htmllib.escape(sub), content=content))
        days.append({"date": f"{d:%Y-%m-%d}", "label": f"{d:%m-%d} 周{WEEKDAY[d.weekday()]}", "status": status})
    put(SITE_DIR / "days.js", "window.BRIEFING_DAYS = " + json.dumps(days, ensure_ascii=False) + ";\n")
    keep = {d["date"] for d in days}
    for f in SITE_DIR.glob("????-??-??.html"):
        if f.stem not in keep:
            f.unlink(missing_ok=True)
    if any(u not in linked for u in figs):
        atomic_write(fig_file, dump({u: f for u, f in figs.items() if u in linked}))


def prune_runs(today):
    if not RUNS_DIR.is_dir():
        return
    for d in RUNS_DIR.iterdir():
        try:
            day = date.fromisoformat(d.name)
        except ValueError:
            continue
        if (today - day).days > KEEP_RUNS_DAYS:
            shutil.rmtree(d, ignore_errors=True)


def acquire_lock():
    for _ in range(3):
        try:
            fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - LOCK_FILE.stat().st_mtime
                text = LOCK_FILE.read_text("utf-8", errors="replace").strip()
            except FileNotFoundError:
                continue
            except OSError:
                return False
            pid = int(text) if text.isdigit() else 0
            if pid and pid_alive(pid):
                return False
            if not pid and age < 60:
                return False
            LOCK_FILE.unlink(missing_ok=True)
            continue
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    return False


def commit(meta, run_dir, day):
    """简报写入输出目录以后的收尾。先存这份简报用过的条目（note.json，partial 的下次补抓时连同这些一起重写），
    再推进水位、记已见 ID、从 pending 去掉写进去的条目。每一步都能重做，中途出错的下次由 recover() 从头补。
    水位和已见日期只往后推：--force 重写往期时别把后来的拉回去。"""
    items = read_json(run_dir / "items.json")
    if items is not None:
        atomic_write(run_dir / "note.json", dump({"items": items, "updates": {}, "span": meta.get("span") or {},
                                                  "notes": meta.get("notes") or []}))
    state = load_state()
    for src, up in (meta.get("updates") or {}).items():
        if src in SOURCES:
            state[src] = newer(src, state.get(src), up)
    cutoff = (now_local().date() - timedelta(days=KEEP_SEEN_DAYS)).isoformat()
    seen = {k: v for k, v in (state.get("seen") or {}).items() if v >= cutoff}
    for k in meta["keys"]:
        seen[k] = max(seen.get(k, ""), day.isoformat())
    state["seen"] = seen
    save_state(state)
    drop_pending(set(meta["keys"]))
    meta["committed"] = True
    atomic_write(run_dir / "meta.json", dump(meta))


def recover(today):
    """最近几天里简报已写入输出目录、收尾没做完的（比如存水位时文件被占着），补做收尾，免得那批条目又进下一份简报。
    凭输出目录中简报属性的 batch 和那天 meta.json 的 batch 对上来认，见 write_note()。"""
    for i in range(MAX_CATCHUP.days, -1, -1):
        day = today - timedelta(days=i)
        meta = read_json(RUNS_DIR / day.isoformat() / "meta.json")
        if meta and meta.get("batch") and not meta.get("committed") and (note_head(day) or {}).get("batch") == meta["batch"]:
            commit(meta, RUNS_DIR / day.isoformat(), day)
            log(f"补做了 {day} 那份简报的收尾（水位、已见条目）")


def produce(material, meta, run_dir, day, keep):
    final = "partial" if meta.get("failures") else "ok"
    if not generate(material, meta, run_dir, day, final, keep):
        return 1
    commit(meta, run_dir, day)
    return 2 if final == "partial" else 0


def run(args, now, today, status):
    day_dir = RUNS_DIR / today.isoformat()
    run_dir = day_dir / "dry-run" if args.dry_run else day_dir
    run_dir.mkdir(parents=True, exist_ok=True)
    keep = status not in (None, "failed")
    saved = None if args.dry_run else read_json(day_dir / "meta.json")

    if args.force:

        if saved is not None and (day_dir / "material.md").exists():
            log(f"--force：沿用 {day_dir} 存下的材料重写 {today} 的简报")
            return produce((day_dir / "material.md").read_text("utf-8"), saved, day_dir, today, keep)
        if keep or today != now.astimezone().date():
            log(f"--force：{day_dir} 里没有存下的材料，不重写")
            return 1
        log("--force：当天还没抓过，照常跑")
    elif not args.dry_run:
        if status not in RETRY:
            log(f"{today} 的简报已有（status={status}），跳过")
            return 0
        if status is None and saved is not None and saved.get("committed"):
            log(f"{today} 已经生成过（简报可能被删了），不重新抓；要重写加 --force")
            return 0
        prune_runs(today)

    done, done_span, done_notes = [], {}, []
    if status == "partial":
        snap = read_json(day_dir / "note.json")
        if snap is not None:
            done, done_span, done_notes = dec_items(snap.get("items")), snap.get("span") or {}, snap.get("notes") or []
        elif not args.dry_run:
            log(f"{today} 那份 partial 简报用过的条目（note.json）缺了或读不了，不重写，免得丢掉已写的内容；要重写加 --force")
            return 2
    state = load_state()
    seen = state.get("seen") or {}
    p_items, p_updates, p_span, p_notes = load_pending(now, seen)
    view = merge_updates({s: state.get(s) for s in SOURCES}, p_updates)
    new, updates, failures, notes, span = collect(view, seen, now)
    done_keys = {x["key"] for x in done}
    merged = {x["key"]: x for x in p_items}
    merged.update((x["key"], x) for x in new)
    todo = [x for k, x in merged.items() if k not in done_keys]
    updates = merge_updates(p_updates, updates)
    t_span, t_notes = merge_span(p_span, span), list(dict.fromkeys(p_notes + notes))
    items = done + todo
    material, links, keys, counts = build_material(items)
    cut_notes = [f"AINews {fmt_time(x['time'])[:5]} 那期正文太长，最后约 {x['cut']} 字符没交给模型" for x in items if x.get("cut")]
    meta = {"batch": "b" + uuid.uuid4().hex[:11], "counts": counts, "span": merge_span(done_span, t_span), "failures": failures,
            "notes": list(dict.fromkeys(done_notes + t_notes + cut_notes)), "links": links, "keys": keys, "updates": updates}
    meta["coverage"] = cov_text(meta["span"])
    n_p = len({x["key"] for x in p_items} - done_keys)
    extra = "、".join(s for s in (f"上次没写成的 {n_p} 条" if n_p else "", f"今天已写过的 {len(done)} 条" if done else "") if s)
    summary = (f"L{counts['L']} J{counts['J']} H{counts['H']}" + (f"（含{extra}）" if extra else "") +
               f"  {meta['coverage']}  材料 {len(material)} 字符" + "".join(f"  抓取失败：{x}" for x in failures))

    if args.dry_run:
        (run_dir / "items.json").write_text(dump(enc_items(items)), "utf-8")
        (run_dir / "material.md").write_text(material, "utf-8", newline="\n")
        (run_dir / "meta.json").write_text(dump(meta), "utf-8")
        prompt = make_prompt(material, today)
        (run_dir / "prompt.md").write_text(prompt, "utf-8", newline="\n")
        print(f"dry-run  {summary}\n提示词：{run_dir / 'prompt.md'}（{len(prompt)} 字符）")
        return 2 if failures else 0
    log(f"抓取  {summary}")
    if status == "partial" and failures and not todo:
        log("还是有来源没抓到，也没有新条目，简报保持 partial")
        return 2
    if failures and not items:
        if not keep:
            write_note(today, "failed", failed_body("抓取（有来源失败，其余没有新内容）", "\n".join(failures), today))
        return 1
    atomic_write(day_dir / "material.md", material)
    atomic_write(day_dir / "items.json", dump(enc_items(items)))
    atomic_write(day_dir / "meta.json", dump(meta))

    atomic_write(PENDING_FILE, dump({"items": enc_items(todo), "updates": updates, "span": t_span, "notes": t_notes}))
    return produce(material, meta, day_dir, today, keep)


def model_name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise argparse.ArgumentTypeError("模型名只能包含字母、数字、点、下划线和连字符")
    return value


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="从公开新闻源生成中文 AI 每日简报")
    modes = ap.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="只抓取、生成素材和提示词，不调用模型、不推进水位")
    modes.add_argument("--force", action="store_true", help="沿用指定日期最后保存的素材重写")
    modes.add_argument("--site", action="store_true", help="只将已有 Markdown 转成网页")
    ap.add_argument("--date", type=date.fromisoformat, help="配合 --force 指定 YYYY-MM-DD")
    ap.add_argument("--output-dir", default=os.environ.get("AI_BRIEFING_OUTPUT_DIR", str(Path.home() / "AI-Briefing")))
    ap.add_argument("--prompt-file", default=os.environ.get("AI_BRIEFING_PROMPT_FILE", str(SCRIPT_DIR / "prompt.md")))
    ap.add_argument("--board-dir", default=os.environ.get("AI_BRIEFING_BOARD_DIR", str(Path.home() / ".claude" / "board")))
    ap.add_argument("--web", action=argparse.BooleanOptionalAction, default=env_bool("AI_BRIEFING_WEB"), help="生成含论文配图的可选网页")
    ap.add_argument("--codex", action=argparse.BooleanOptionalAction, default=env_bool("AI_BRIEFING_CODEX", True), help="Claude 未完成时尝试 Codex")
    ap.add_argument("--claude-model", type=model_name, default=os.environ.get("AI_BRIEFING_CLAUDE_MODEL", CLAUDE_MODEL))
    ap.add_argument("--claude-effort", choices=("low", "medium", "high", "xhigh", "max"), default=os.environ.get("AI_BRIEFING_CLAUDE_EFFORT", CLAUDE_EFFORT))
    ap.add_argument("--codex-model", type=model_name, default=os.environ.get("AI_BRIEFING_CODEX_MODEL", MODEL))
    ap.add_argument("--codex-effort", choices=("low", "medium", "high", "xhigh", "max"), default=os.environ.get("AI_BRIEFING_CODEX_EFFORT", EFFORT))
    args = ap.parse_args(argv)
    if args.date and not args.force:
        ap.error("--date 只能和 --force 一起使用")
    if not args.site and not Path(args.prompt_file).expanduser().is_file():
        ap.error("找不到 prompt.md；请将它和脚本放在一起，或设置 --prompt-file")
    return args


def main(argv=None):
    global DEADLINE
    try:
        args = parse_args(argv)
    except ValueError as exc:
        print(str(exc))
        return 1
    configure(args)
    DEADLINE = time.time() + RUN_BUDGET
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    today = args.date or now.astimezone().date()
    if not acquire_lock():
        log("上一次还没跑完，跳过")
        return 0
    try:
        if args.site:
            build_site()
            print(SITE_DIR / "index.html")
            return 0
        if not args.dry_run:
            recover(now.astimezone().date())
        return run(args, now, today, note_status(today))
    except Exception as exc:
        log("脚本出错：" + traceback.format_exc().replace("\n", " | "))
        if not args.dry_run:
            try:
                if note_status(today) in (None, "failed"):
                    write_note(today, "failed", failed_body("脚本出错", errtext(exc), today))
            except Exception as write_error:
                log(f"失败简报也没写成：{errtext(write_error)}")
        return 1
    finally:
        LOCK_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
