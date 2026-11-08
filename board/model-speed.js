'use strict';

const fs = require('fs');
const { PROJECTS, accounts, snapshot } = require('./board-config');
const { sessionEvents, owner, walk } = require('./claude-cost');
const codex = require('./codex-usage');

const WINDOW = 3600;
const MAXDUR = 900;
const MINOUT = 200; // 短回复主要消耗在首字等待，不用于速度统计

// 只读文件尾；请求可能异步落盘，后续按时间戳配对。
function tail(file, size, since) {
  for (let chunk = 1 << 20; ; chunk *= 4) {
    const start = Math.max(0, size - chunk);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const objs = [];
    for (const l of lines) {
      if (!l) continue;
      try { objs.push(JSON.parse(l)); } catch {}
    }
    const first = objs.find((o) => o.timestamp);
    if (start === 0 || chunk >= 64 << 20 || (first && Date.parse(first.timestamp) / 1000 < since)) return objs;
  }
}

function latestBefore(sorted, t) {
  let x = null;
  for (const v of sorted) {
    if (v <= t) x = v;
    else break;
  }
  return x;
}

function claudeRequests(now) {
  const since = now - WINDOW;
  const out = [];
  for (const file of walk(PROJECTS, [])) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs / 1000 < since) continue;
    let objs;
    try { objs = tail(file, st.size, since - MAXDUR); } catch { continue; }
    const sends = [];
    const users = [];
    const resp = new Map();
    for (const o of objs) {
      const t = Date.parse(o.timestamp) / 1000;
      if (!Number.isFinite(t)) continue;
      if (o.type === 'api-request') {
        const q = o.querySource || '';
        if (q === 'repl_main_thread' || q.startsWith('agent')) sends.push(t);
      } else if (o.type === 'user') {
        users.push(t);
      } else if (o.type === 'assistant' && /^req_/.test(o.requestId || '') && o.message && o.message.usage) {
        const n = o.message.usage.output_tokens || 0;
        const r = resp.get(o.requestId);
        if (!r) resp.set(o.requestId, { first: t, last: t, out: n, model: o.message.model, sid: o.sessionId });
        else {
          r.first = Math.min(r.first, t);
          r.last = Math.max(r.last, t);
          r.out = Math.max(r.out, n);
        }
      }
    }
    sends.sort((a, b) => a - b);
    users.sort((a, b) => a - b);
    let prevLast = null;
    for (const r of [...resp.values()].sort((a, b) => a.first - b.first)) {
      const send = latestBefore(sends, r.first);
      let start = send == null ? latestBefore(users, r.first) : send;
      // 同一文件的请求串行，起点不能早于上一条回复结束。
      if (prevLast != null && (start == null || start < prevLast)) start = prevLast;
      prevLast = r.last;
      if (start == null || r.last < since) continue;
      const dur = r.last - start;
      if (dur > 0 && dur <= MAXDUR) out.push({ sid: r.sid, start, out: r.out, model: r.model, dur });
    }
  }
  return out;
}

// 总输出 / 总耗时，按模型分组；次数最多的模型排在卡片首位。
function aggregate(list) {
  const by = new Map();
  const long = list.filter((r) => r.out >= MINOUT);
  if (list.length && !long.length) return { models: [], short: list.length };
  for (const r of long) {
    let m = by.get(r.model);
    if (!m) by.set(r.model, (m = { model: r.model, n: 0, out: 0, dur: 0 }));
    m.n++;
    m.out += r.out;
    m.dur += r.dur;
  }
  const models = [...by.values()].sort((a, b) => b.n - a.n || b.out - a.out);
  for (const m of models) m.dur = Math.round(m.dur * 10) / 10;
  return models.length ? { models } : null;
}

function compute() {
  const now = Date.now() / 1000;
  const since = now - WINDOW;
  const ev = sessionEvents();
  const per = Object.fromEntries(accounts().map((a) => [a.id, []]));
  for (const r of claudeRequests(now)) {
    const a = owner(ev.get(r.sid), r.start);
    if (a && per[a]) per[a].push(r);
  }
  const cxOf = () => {
    const cx = [];
    for (const r of codex.records(since)) {
      if (r.start == null) continue;
      const dur = r.end - r.start;
      if (dur > 0 && dur <= MAXDUR) cx.push({ model: r.model, out: (r.u && r.u.output_tokens) || 0, dur });
    }

    return cx;
  };
  const res = { at: Math.floor(now), win: WINDOW, accts: {} };
  for (const [k, list] of Object.entries(per)) res.accts[k] = aggregate(list);
  res.codex = aggregate(cxOf());
  if (!Object.hasOwn(per, 'codex')) res.accts.codex = res.codex;
  snapshot('speed', res, 'SPEED');
  return res;
}

module.exports = { compute, claudeRequests, aggregate };

if (require.main === module) {
  const t0 = Date.now();
  const r = compute();
  for (const [k, v] of Object.entries(r.accts)) {
    const line = v && !v.models.length ? `近 1 小时没有长回复（${v.short} 次短回复）` : v ? v.models.map((m) => `${m.model} ${m.n} 次 ${Math.round(m.out / m.dur)} token/秒 每次 ${(m.dur / m.n).toFixed(1)} 秒`).join('；') : '近 1 小时没用';
    console.log(`${k.toUpperCase().padEnd(5)} ${line}`);
  }
  console.log(`耗时 ${Date.now() - t0} ms`);
}
