#!/usr/bin/env node
// Claude Code statusline — Catppuccin Mocha
// 输出：模型 | effort | 工作目录(+git分支) | ctx 已用/占比 | 账号（多账号时是切号顺序） | 5h/本周额度 | 缓存命中率 | 花费 | 行数增删
// 装了额度看板（~/.claude/board 存在）时，顺便把本账号的额度快照和花费增量写给看板，见 recordRateLimits、recordCost。
// 数据来自 stdin 的 JSON，字段见 https://code.claude.com/docs/en/statusline
//
// 宽度自适应：Claude Code 在运行本脚本前设置 COLUMNS（v2.1.153+）。
// 放不下时按 prio 从大到小丢段落，而不是让终端硬截断。

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 看板目录存在才记录，没装看板的电脑什么都不写
const BOARD_DIR = process.env.CLAUDE_BOARD_DIR || path.join(os.homedir(), '.claude', 'board');

// 账号 id：主账号（不设 CLAUDE_CONFIG_DIR，或设成 ~/.claude）是 a，副号是 ~/.claude-<id>；其他配置目录返回 null
function accountId() {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg) return 'a';
  const base = path.basename(cfg.replace(/[\\/]+$/, ''));
  if (/^\.claude$/i.test(base)) return 'a';
  const m = base.match(/^\.claude-([a-z0-9][a-z0-9-]*)$/i);
  return m ? m[1].toLowerCase() : null;
}

// Catppuccin Mocha，24-bit 真彩色
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[38;2;108;112;134m', // overlay0 — 分隔符
  mauve: '\x1b[38;2;203;166;247m',
  blue: '\x1b[38;2;137;180;250m',
  green: '\x1b[38;2;166;227;161m',
  yellow: '\x1b[38;2;249;226;175m',
  peach: '\x1b[38;2;250;179;135m',
  red: '\x1b[38;2;243;139;168m',
  teal: '\x1b[38;2;148;226;213m',
  sky: '\x1b[38;2;137;220;235m',
  subtext: '\x1b[38;2;166;173;200m',
};

const c = (color, s) => `${color}${s}${C.reset}`;

// 终端显示宽度：CJK 全角和 emoji 占 2 列
function dispWidth(s) {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
    const p = ch.codePointAt(0);
    const wide =
      (p >= 0x1100 && p <= 0x115f) ||
      p === 0x2329 || p === 0x232a ||
      (p >= 0x2e80 && p <= 0xa4cf && p !== 0x303f) ||
      (p >= 0xac00 && p <= 0xd7a3) ||
      (p >= 0xf900 && p <= 0xfaff) ||
      (p >= 0xfe30 && p <= 0xfe6f) ||
      (p >= 0xff00 && p <= 0xff60) ||
      (p >= 0xffe0 && p <= 0xffe6) ||
      (p >= 0x1f300 && p <= 0x1f64f) ||
      (p >= 0x1f900 && p <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

// 大数字压成 1.2k / 5.17M
function human(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// 按占比给颜色：<70 绿，70-89 黄，>=90 红
function pctColor(p) {
  if (p >= 90) return C.red;
  if (p >= 70) return C.yellow;
  return C.green;
}

function gitBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 700,
    }).trim();
  } catch {
    return '';
  }
}

// 把本账号的 rate_limits 快照写给看板。只记录 Claude Code 自己收到的数据，不发任何请求。
function recordRateLimits(d, acct) {
  const rl = d.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return;
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const jsonFile = path.join(BOARD_DIR, `acct-${acct}.json`);

  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch {}

  // 窗口过了 resets_at 后 Claude Code 会把它从 rate_limits 里去掉，所以缺的窗口沿用旧值，由页面按时间判断已重置
  const pick = (w) => (w && typeof w.used_percentage === 'number' ? { pct: w.used_percentage, reset: w.resets_at } : null);
  const five = pick(rl.five_hour) || old.five || null;
  const week = pick(rl.seven_day) || old.week || null;
  const now = Math.floor(Date.now() / 1000);
  const same = JSON.stringify([five, week]) === JSON.stringify([old.five, old.week]);
  if (same && now - (old.at || 0) < 30) return;

  // 订阅开通时间（UTC）给页面按月推到期日；退订再重订会变，所以每次写快照都重读
  let email = old.email;
  let sub = old.sub;
  try {
    const f = cfg ? path.join(cfg, '.claude.json') : path.join(os.homedir(), '.claude.json');
    const o = JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount || {};
    email = o.emailAddress || email;
    const t = Date.parse(o.subscriptionCreatedAt);
    if (t) sub = Math.floor(t / 1000);
  } catch {}

  const body = JSON.stringify({ acct, email: email || '', sub: sub || null, five, week, at: now });
  // 先写临时文件再改名，浏览器刷新时不会读到半截
  for (const [file, text] of [
    [jsonFile, body],
    [path.join(BOARD_DIR, `acct-${acct}.js`), `(window.ACCTS=window.ACCTS||{})[${JSON.stringify(acct)}]=${body};\n`],
  ]) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
}

// 切号顺序：和看板页面顶部一致，排序规则共用看板目录的 order.js。只读看板目录里的快照，不发请求。
// 第一个是现在该用的号（绿色），方括号是当前这个号，灰色的是暂时用不了或没有额度快照的号。账号不到两个时返回 null
function switchOrder(acct) {
  const O = require(path.join(BOARD_DIR, 'order.js'));
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const list = (readJson(path.join(BOARD_DIR, 'accounts.json')).accounts || [])
    .filter((a) => a && typeof a.id === 'string' && /^[a-z0-9-]+$/.test(a.id));
  if (list.length < 2) return null;
  const accts = {}, warmup = {};
  for (const { id } of list) {
    try {
      accts[id] = readJson(path.join(BOARD_DIR, `acct-${id}.json`));
    } catch {}
    try {
      // warmup-<号>.js 是 (window.WARMUP=window.WARMUP||{})["a"]={...};
      const m = fs.readFileSync(path.join(BOARD_DIR, `warmup-${id}.js`), 'utf8').match(/\]=(\{[\s\S]*\})\s*;?\s*$/);
      if (m) warmup[id] = JSON.parse(m[1]);
    } catch {}
  }
  const now = Date.now() / 1000;
  const { order, usable } = O.rank(O.rows(list, accts, warmup, now), now);
  const items = order.map((r, i) => {
    const name = r.id.length === 1 ? r.id.toUpperCase() : r.id;
    const col = !usable(r) ? C.dim : i === 0 ? C.green : C.subtext;
    return r.id === acct ? `${c(C.sky, '[')}${c(col, name)}${c(C.sky, ']')}` : c(col, name);
  });
  return `${c(C.dim, '切号')} ${items.join(c(C.dim, '›'))}`;
}

// 把本账号的花费增量记进看板的 ledger-YYYY-MM.log，看板按窗口加总成美金。
// total_cost_usd 是 Claude Code 自己按 API 价算的本会话累计（含子代理和联网搜索，不含标题生成这类 side query）；
// 续接会话时它从会话记录里恢复整段的累计，不分是哪个号花的。所以上次的值按“会话 + 进程”记在 seen/<会话ID>，
// 每个进程第一次出现只记基线，之后只记它自己的增量：续接（换不换号都一样）不会把恢复的累计再记一遍，
// 两个终端同时开同一会话也不会互相顶。
// 进程用 now - total_duration_ms 认（Claude Code 进程的起始时间，状态栏启动有延迟，留 15 秒容差）；
// 同一进程里累计变小不该发生，当作新基线、不记。用 API key 或自定义 ANTHROPIC_BASE_URL 的进程不是订阅额度，不记。
function recordCost(d, acct) {
  const v = d.cost && d.cost.total_cost_usd;
  const dur = d.cost && d.cost.total_duration_ms;
  const sid = d.session_id;
  if (typeof v !== 'number' || typeof dur !== 'number' || !sid || !/^[\w-]+$/.test(sid)) return;
  if (process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return;
  const seenDir = path.join(BOARD_DIR, 'seen');
  const seenFile = path.join(seenDir, sid);
  const nowMs = Date.now();
  const start = (nowMs - dur) / 1000;
  // seen 内容：[[进程起始秒, 上次累计, 上次写入秒], ...]
  let procs = [];
  try {
    const o = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (Array.isArray(o)) procs = o;
  } catch {}
  // 算出的起点会抖十几秒，容差内可能有好几条。只取第一条会在两条之间来回认、拿旧值算增量，把同一段记好几遍；
  // 所以认累计不超过当前值里最大的那条，其余落在容差内的删掉。续接的进程起点也落在这里，和同会话的旧进程本来就分不开
  const near = procs.filter((x) => Math.abs(x[0] - start) <= 15);
  let p = near.filter((x) => x[1] <= v).sort((x, y) => y[1] - x[1])[0] || near.sort((x, y) => y[2] - x[2])[0];
  if (p) procs = procs.filter((x) => x === p || !near.includes(x));
  if (p && p[1] === v) return;
  const last = p ? p[1] : NaN;
  if (p) Object.assign(p, [Math.min(p[0], start), v, nowMs / 1000]); // 延迟越小越接近真实起点
  else procs.push((p = [start, v, nowMs / 1000]));
  procs = procs.filter((x) => nowMs / 1000 - x[2] < 3 * 86400).sort((x, y) => x[2] - y[2]).slice(-8);
  // 先改名写好 seen 再记账：中途出错宁可漏一笔，也不重复记
  fs.mkdirSync(seenDir, { recursive: true });
  const tmp = `${seenFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(procs));
  fs.renameSync(tmp, seenFile);
  // 进程第一次出现记一行 0 当基线：看板把每个会话的第一行当记账起点、不计金额，起点之前的花费由会话记录补
  const delta = Number.isNaN(last) ? 0 : v - last;
  if (!Number.isNaN(last) && !(delta > 0)) return;
  const month = new Date(nowMs).toISOString().slice(0, 7);
  fs.appendFileSync(path.join(BOARD_DIR, `ledger-${month}.log`), `${Math.floor(nowMs / 1000)}\t${acct}\t${sid}\t${delta.toFixed(6)}\n`);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    process.exit(0); // 输入坏了就什么都不显示，别把状态栏搞成报错
  }

  const acct = accountId();
  const board = acct && fs.existsSync(BOARD_DIR);
  if (board) {
    try {
      recordRateLimits(d, acct);
    } catch {} // 看板写失败不能影响状态栏
    try {
      recordCost(d, acct);
    } catch {}
  }

  // prio 越大越先被丢弃；0 = 永不丢弃
  const segs = [];
  const add = (prio, text) => segs.push({ prio, text });

  // ── 模型（+ 1M context 标记）
  const model = d.model?.display_name || d.model?.id || '?';
  const win = d.context_window?.context_window_size || 0;
  add(0, c(C.mauve, model + (win >= 1e6 ? ' 1M' : '')));

  // ── fast mode / effort 等级
  const flags = [];
  if (d.fast_mode) flags.push('fast');
  const eff = d.effort?.level;
  if (eff) flags.push(eff);
  if (flags.length) add(0, c(C.peach, flags.join('/')));

  // ── 工作目录 + git 分支
  const cwd = d.workspace?.current_dir || d.cwd || '';
  if (cwd) {
    const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
    add(1, c(C.blue, name));
    const br = gitBranch(cwd);
    if (br) add(4, c(C.subtext, br));
  }

  // ── 上下文占用（首次 API 响应前无数据，不显示占位的 0）
  const cw = d.context_window;
  const used = cw?.total_input_tokens || 0;
  if (used > 0) {
    const pct = Math.round(cw.used_percentage ?? 0);
    add(0.5, c(pctColor(pct), `${human(used)}/${pct}%`));
  }

  // ── 当前账号：紧挨着额度放，一眼看出是哪个号的额度。只有一个号又没装看板时不显示
  // 单字母的 id 显示成“A号”，其他原样；认不出的配置目录显示目录名
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  // 装了看板且账号不止一个时换成切号顺序，当前号在里面用方括号标出，不再单独显示“X号”
  if (acct && (cfg || board)) {
    let order = null;
    if (board) {
      try {
        order = switchOrder(acct);
      } catch {} // 看板文件缺了或坏了就退回只显示“X号”
    }
    add(0, order || c(C.sky, acct.length === 1 ? acct.toUpperCase() + '号' : acct));
  } else if (cfg) {
    add(0, c(C.sky, cfg.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/^\./, '')));
  }

  // ── 订阅额度：5 小时 / 本周。平时只显示百分比，>=90% 快卡住时才带重置时间（本地时区）
  // 5 小时不丢；本周 prio 0.6，先于上下文占用丢；API key 登录没有 rate_limits，不显示
  const nowSec = Date.now() / 1000;
  const pad = (n) => String(n).padStart(2, '0');
  const localTime = (s, withDate) => {
    const t = new Date(s * 1000);
    const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    return withDate ? `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${hm}` : hm;
  };
  const quota = (prio, label, w, withDate) => {
    if (!w || typeof w.used_percentage !== 'number' || !(w.resets_at > nowSec)) return;
    const p = Math.round(w.used_percentage);
    const reset = p >= 90 ? ' ' + c(C.dim, '↻' + localTime(w.resets_at, withDate)) : '';
    add(prio, `${c(C.dim, label)} ${c(pctColor(p), p + '%')}${reset}`);
  };
  quota(0, '5h', d.rate_limits?.five_hour, false);
  quota(0.6, '周', d.rate_limits?.seven_day, true);

  const cu = cw?.current_usage;
  if (cu) {
    const inTotal =
      (cu.input_tokens || 0) +
      (cu.cache_creation_input_tokens || 0) +
      (cu.cache_read_input_tokens || 0);

    // ── 缓存命中率：读缓存 / 总输入。命中率越高越省钱，配色反过来
    if (inTotal > 0) {
      const hit = Math.round(((cu.cache_read_input_tokens || 0) / inTotal) * 100);
      const col = hit >= 70 ? C.green : hit >= 30 ? C.yellow : C.red;
      add(3, `${c(C.dim, 'cache')} ${c(col, hit + '%')}`);
    }
  }

  // ── 花费
  const cost = d.cost?.total_cost_usd;
  if (typeof cost === 'number' && cost > 0) {
    add(2, c(C.teal, '$' + (cost >= 10 ? cost.toFixed(1) : cost.toFixed(2))));
  }

  // ── 代码行数增删
  const la = d.cost?.total_lines_added || 0;
  const ld = d.cost?.total_lines_removed || 0;
  if (la || ld) {
    add(7, `${c(C.green, '+' + la)}${c(C.dim, '/')}${c(C.red, '-' + ld)}`);
  }

  // ── 按可用宽度裁剪
  // COLUMNS 是终端宽度，状态栏两侧另有内置留白，留 6 列余量
  const cols = parseInt(process.env.COLUMNS || '0', 10);
  const budget = cols > 20 ? cols - 6 : Infinity;
  const SEP = c(C.dim, ' │ ');
  const SEP_W = 3;

  const render = (list) => list.map((s) => s.text).join(SEP);
  const widthOf = (list) =>
    list.reduce((sum, s) => sum + dispWidth(s.text), 0) + Math.max(0, list.length - 1) * SEP_W;

  let keep = segs.slice();
  while (widthOf(keep) > budget && keep.length > 1) {
    // 找出当前最高 prio（最该丢的），从右往左丢
    let worst = -1;
    let worstIdx = -1;
    for (let i = keep.length - 1; i >= 0; i--) {
      if (keep[i].prio > worst) {
        worst = keep[i].prio;
        worstIdx = i;
      }
    }
    if (worst <= 0) break; // 剩下的都是不可丢弃的
    keep.splice(worstIdx, 1);
  }

  process.stdout.write(render(keep) + '\n');
});
