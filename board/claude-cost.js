'use strict';

const fs = require('fs');
const path = require('path');
const { DIR, PROJECTS, accounts, configPath, atomicWrite, snapshot } = require('./board-config');

const CACHE = path.join(DIR, 'cost-cache.json');
const KEEP = 9 * 86400;
const PRICE_VERSION = 4; // 单价或算法变更时丢弃旧缓存

// 美元 / 百万 token：输入、输出、短缓存写、长缓存写、缓存读。
const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 8, 0.2],
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
};

function price(model, u) {
  const p = PRICES[String(model).replace(/\[.*\]$/, '')];
  if (!p) return null;
  const [inp, out, w5, w1, rd] = p;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  let w5m = cc.ephemeral_5m_input_tokens || 0;
  if (!w1h && !w5m) w5m = u.cache_creation_input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + read + w1h + w5m;
  let k = 1;
  if (model.startsWith('claude-haiku-5-5') && prompt > 100000) k *= 5;
  if (u.speed === 'fast') k *= 2;
  const usd = ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + w5m * w5 + w1h * w1 + read * rd) * k / 1e6;
  return usd + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * 0.01;
}

// 目录时间和账本共同确定续接会话在各个时刻属于哪个账号。
function sessionEvents(list = accounts(), rows = readLedger(Date.now() / 1000, list)) {
  const ev = new Map();
  const push = (sid, t, a) => (ev.get(sid) || ev.set(sid, []).get(sid)).push([t, a]);
  for (const account of list) {
    const a = account.id;
    const root = path.join(configPath(account), 'session-env');
    let sids = [];
    try { sids = fs.readdirSync(root); } catch {}
    for (const sid of sids) {
      try {
        const p = path.join(root, sid);
        push(sid, fs.statSync(p).birthtimeMs / 1000, a);
        for (const f of fs.readdirSync(p)) push(sid, fs.statSync(path.join(p, f)).mtimeMs / 1000, a);
      } catch {}
    }
  }

  for (const [t, a, sid] of rows) push(sid, t, a);
  for (const list of ev.values()) list.sort((x, y) => x[0] - y[0]);
  return ev;
}

function owner(list, t) {
  if (!list) return null;
  let a = null;
  for (const [ts, acct] of list) {
    if (ts <= t + 5) a = acct;
    else break;
  }
  return a;
}

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const MARK = Buffer.from('"requestId":"req_');

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.v === PRICE_VERSION && c.files && c.msgs) return c;
  } catch {}
  return { v: PRICE_VERSION, files: {}, msgs: {} };
}

// 最后一行可能尚未写完，保留偏移供下次读取；缓存使用相对路径。
function scan(cache, now) {
  const since = now - KEEP;
  const seen = new Set();
  for (const file of walk(PROJECTS, [])) {
    const key = path.relative(PROJECTS, file);
    seen.add(key);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let rec = cache.files[key];
    if (!rec || st.size < rec.offset) rec = cache.files[key] = { offset: 0 };
    if (st.mtimeMs / 1000 < since || st.size === rec.offset) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const CH = 8 << 20;
      let pos = rec.offset;
      let carry = Buffer.alloc(0);
      while (pos < st.size) {
        const buf = Buffer.alloc(Math.min(CH, st.size - pos));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl < 0) break;
          const line = data.subarray(start, nl);
          if (line.indexOf(MARK) >= 0) take(cache, line, since);
          start = nl + 1;
        }
        carry = Buffer.from(data.subarray(start));
      }
      rec.offset = pos - carry.length;
    } finally {
      fs.closeSync(fd);
    }
  }
  for (const f of Object.keys(cache.files)) if (!seen.has(f)) delete cache.files[f];
}

function take(cache, line, since) {
  let o;
  try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  const m = o.message;
  const u = m && m.usage;
  if (o.type !== 'assistant' || !u || !/^req_/.test(o.requestId || '')) return;
  const t = Date.parse(o.timestamp) / 1000;
  if (!(t >= since)) return;
  const usd = price(m.model || '', u);
  const out = u.output_tokens || 0;

  // 流式消息会落多行，只保留输出最多、金额最大的版本。
  const old = cache.msgs[m.id];
  if (old && (old[4] > out || (old[4] === out && (old[3] || 0) >= (usd || 0)))) return;
  cache.msgs[m.id] = [t, o.sessionId, m.model, usd, out];
}

function ledgerSessions(rows) {
  const map = new Map();
  for (const [t, , sid] of rows) {
    const s = map.get(sid);
    if (!s) map.set(sid, [t, t]);
    else { s[0] = Math.min(s[0], t); s[1] = Math.max(s[1], t); }
  }
  return map;
}

function readLedger(now, list = accounts()) {
  const ids = new Set(list.map((a) => a.id));
  const rows = [];
  const from = new Date((now - KEEP) * 1000).toISOString().slice(0, 7);
  let names = [];
  try { names = fs.readdirSync(DIR); } catch {}
  for (const f of names) {
    const mo = (f.match(/^ledger-(\d{4}-\d{2})\.log$/) || [])[1];
    if (!mo || mo < from) continue;
    let text;
    try { text = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const parts = line.split('\t');
      if (parts.length !== 4) continue;
      const t = Number(parts[0]);
      const usd = Number(parts[3]);
      if (!ids.has(parts[1]) || !parts[2] || !Number.isFinite(t) || t > now + 5 || !Number.isFinite(usd) || usd < 0) continue;
      if (t >= now - KEEP) rows.push([t, parts[1], parts[2], usd]);
    }
  }
  return rows;
}

function readAcct(k) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `acct-${k}.json`), 'utf8')); } catch { return null; }
}

function windowStart(w, len, now) {
  if (!w || !Number.isFinite(w.reset) || !w.reset) return null;
  if (w.reset > now) return w.reset - len;
  return now - w.reset <= len ? w.reset : null;
}

function compute() {
  const now = Date.now() / 1000;
  const cache = loadCache();
  scan(cache, now);
  for (const [id, v] of Object.entries(cache.msgs)) if (v[0] < now - KEEP) delete cache.msgs[id];
  atomicWrite(CACHE, JSON.stringify(cache));

  const list = accounts();
  const rows = readLedger(now, list);
  const ev = sessionEvents(list, rows);
  const wins = {};
  const out = {};
  for (const { id: k } of list) {
    const r = readAcct(k);
    wins[k] = r ? { five: windowStart(r.five, 5 * 3600, now), week: windowStart(r.week, 7 * 86400, now) } : {};

    out[k] = {};
    for (const n of ['five', 'week']) if (wins[k][n] != null) Object.assign(out[k], { [n]: 0, [n + 'Est']: 0 });
  }
  const add = (a, t, usd, est) => {
    for (const n of ['five', 'week']) {
      if (wins[a][n] == null || t < wins[a][n]) continue;
      out[a][n] += usd;
      if (est) out[a][n + 'Est'] += usd;
    }
  };

  const led = ledgerSessions(rows);

  const msgsBySid = new Map();
  for (const [t, sid, , usd] of Object.values(cache.msgs)) {
    if (usd != null) (msgsBySid.get(sid) || msgsBySid.set(sid, []).get(sid)).push([t, usd]);
  }

  const buckets = new Map();
  const bucket = (a, n, sid) => {
    const k = `${a}\t${n}\t${sid}`;
    return buckets.get(k) || buckets.set(k, { a, n, sid, led: 0, ledEst: 0, tr: 0 }).get(k);
  };
  const inWin = (a, n, t) => wins[a] && wins[a][n] != null && t >= wins[a][n];
  const addLedger = (a, sid, t, usd, est) => {
    for (const n of ['five', 'week']) {
      if (!inWin(a, n, t)) continue;
      const b = bucket(a, n, sid);
      b.led += usd;
      if (est) b.ledEst += usd;
    }
  };
  const prevRow = new Map();
  for (const r of [...rows].sort((x, y) => x[0] - y[0])) {
    const [t, a, sid, usd] = r;
    const prev = prevRow.get(sid);
    prevRow.set(sid, t);

    // 每个进程首行金额为 0，只标记起点；会话首行之前的花费由会话记录补算。
    // 按行序识别首行，后续增量即使落在同一秒也要计入。
    if (prev === undefined || usd === 0) continue;
    const msgs = msgsBySid.get(sid);
    // 续接可能让恢复的累计金额被记成增量，用同段请求核对大额记录。
    if (usd > 3 && msgs) {
      const est = msgs.reduce((sum, [mt, mu]) => sum + (mt > prev && mt <= t + 5 ? mu : 0), 0);
      if (usd > est * 2 + 1) { addLedger(a, sid, t, est, true); continue; }
    }
    addLedger(a, sid, t, usd, false);
  }

  const stray = { usd: 0, n: 0, sessions: new Set() };
  const unpriced = new Set();
  const weekStart = Math.min(...Object.values(wins).map((w) => (w.week == null ? Infinity : w.week)));
  for (const [t, sid, model, usd] of Object.values(cache.msgs)) {
    const span = led.get(sid);
    const covered = span && t > span[0] && t <= span[1] + 5;
    if (usd == null) { unpriced.add(model); continue; }
    const a = owner(ev.get(sid), t);
    if (!a) {
      if (!covered && t >= weekStart) { stray.usd += usd; stray.n++; stray.sessions.add(sid); }
      continue;
    }
    if (!covered) { add(a, t, usd, true); continue; }
    for (const n of ['five', 'week']) if (inWin(a, n, t)) bucket(a, n, sid).tr += usd;
  }
  // 会话记录缺少部分后台调用；仅在明显重复记账时用带余量的估算替代。
  for (const b of buckets.values()) {
    if (msgsBySid.has(b.sid) && b.led > b.tr * 1.35 + 1) {
      out[b.a][b.n] += b.tr * 1.2;
      out[b.a][b.n + 'Est'] += b.tr * 1.2;
    } else {
      out[b.a][b.n] += b.led;
      out[b.a][b.n + 'Est'] += b.ledEst;
    }
  }
  const res = {
    at: Math.floor(now),
    wins,
    accts: out,
    stray: { usd: stray.usd, n: stray.n, sessions: [...stray.sessions] },
    unpriced: [...unpriced],
  };
  snapshot('cost', res, 'COST');
  return res;
}

module.exports = { compute, price, sessionEvents, owner, walk, windowStart };

if (require.main === module) {
  const t0 = Date.now();
  const r = compute();
  const f = (x) => (x == null ? '—' : '$' + x.toFixed(2));
  for (const [k, v] of Object.entries(r.accts)) {
    console.log(`${k.toUpperCase()}  5小时 ${f(v.five)}（补算 ${f(v.fiveEst)}）  本周 ${f(v.week)}（补算 ${f(v.weekEst)}）`);
  }
  console.log(`没认出号的订阅请求（本周最早窗口起）：${r.stray.n} 条 $${r.stray.usd.toFixed(2)}，会话 ${r.stray.sessions.join(' ')}`);
  if (r.unpriced.length) console.log('没有单价的模型：', r.unpriced.join(' '));
  console.log(`耗时 ${Date.now() - t0} ms`);
}
