'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CODEX_HOME, codexAuth } = require('./board-config');

const roots = ['sessions', 'archived_sessions'].map((d) => path.join(CODEX_HOME, d));
const cache = new Map();

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(file);
  }
  return out;
}

// 正在追加的 Windows 文件需要通过句柄读取最新大小和修改时间。
function statOpen(file) {
  const fd = fs.openSync(file, 'r');
  try { return fs.fstatSync(fd); } finally { fs.closeSync(fd); }
}

function metadata(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let data = '';
    const buf = Buffer.alloc(64 << 10);
    for (let pos = 0; pos < 16 << 20;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      data += buf.subarray(0, n).toString('utf8');
      const nl = data.indexOf('\n');
      if (nl < 0) continue;
      const head = JSON.parse(data.slice(0, nl));
      return head.type === 'session_meta' ? head.payload : null;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

const HEAD = /^\{\s*"timestamp"\s*:\s*"([^"]+)"(?:\s*,\s*"ordinal"\s*:\s*\d+)?\s*,\s*"type"\s*:\s*"([a-z_]+)"(?:\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)")?/;

function parse(text) {
  const recs = [], fallback = [];
  let model = null, tier = null, lastIn = null, prevEnd = null, total = 0;
  for (const line of text.split('\n')) {
    const m = HEAD.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]) / 1000, type = m[2], ptype = m[3];
    if (!Number.isFinite(t)) continue;
    if (type === 'turn_context') {
      try {
        const p = JSON.parse(line).payload;
        model = p.model || model;
        tier = p.service_tier || p.serviceTier || null;
      } catch {}
      lastIn = t;
    } else if (type === 'response_item') {
      if (ptype && /_output$/.test(ptype)) lastIn = t;
      else if (ptype === 'message' && /"role"\s*:\s*"(user|developer)"/.test(line.slice(0, 400))) lastIn = t;
    } else if (type === 'event_msg') {
      if (['token_count', 'task_started', 'user_message'].includes(ptype)) lastIn = t;
      if (ptype === 'token_count') {
        try {
          const info = JSON.parse(line).payload.info;
          const tt = info && info.total_token_usage && info.total_token_usage.total_tokens;
          if (tt > total && info.last_token_usage) {
            total = tt;
            fallback.push({ id: null, start: null, end: t, model, tier, u: info.last_token_usage });
          }
        } catch {}
      }
    } else if (type === 'token_usage_record') {
      let p;
      try { p = JSON.parse(line).payload; } catch { continue; }
      const start = Math.max(lastIn ?? -Infinity, prevEnd ?? -Infinity);
      recs.push({ id: p.response_id || null, start: Number.isFinite(start) ? start : null,
        end: t, model, tier: p.service_tier || p.serviceTier || tier, u: p.usage || null });
      prevEnd = t;
    }
  }
  // 旧记录只用于计价；没有准确起点时不猜测输出速度。
  return recs.length ? recs : fallback;
}

function records(since) {
  const auth = codexAuth();
  if (!auth) return [];
  const out = [], ids = new Set(), seen = new Set();
  for (const root of roots) for (const file of walk(root, [])) {
    seen.add(file);
    let st;
    try { st = statOpen(file); } catch { continue; }
    if (st.mtimeMs / 1000 < since) continue;
    let c = cache.get(file);
    if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs || c.authKey !== auth.key) {
      try {
        const meta = metadata(file);
        // 同一目录可能有不同登录方式的历史；没有订阅账号标记的记录不混入金额。
        const eligible = meta && meta.model_provider === 'openai' && meta.creator_account_id === auth.accountId;
        c = { size: st.size, mtimeMs: st.mtimeMs, authKey: auth.key, accountId: meta && meta.creator_account_id,
          recs: eligible ? parse(fs.readFileSync(file, 'utf8')) : [] };
        cache.set(file, c);
      } catch { continue; }
    }
    if (c.accountId !== auth.accountId) continue;
    for (const r of c.recs) {
      if (r.end < since || r.end > Date.now() / 1000 + 5) continue;
      if (r.id) {
        if (ids.has(r.id)) continue;
        ids.add(r.id);
      }
      out.push(r);
    }
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
  return out;
}

// 走 Packy 的 Codex 会话：不看订阅账号，只看会话的 provider。这些记录不混进订阅的金额和额度
const packyCache = new Map();
function packyRecords(since) {
  const out = [], ids = new Set();
  for (const root of roots) for (const file of walk(root, [])) {
    let st;
    try { st = statOpen(file); } catch { continue; }
    if (st.mtimeMs / 1000 < since) continue;
    let c = packyCache.get(file);
    if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
      try {
        const meta = metadata(file);
        c = { size: st.size, mtimeMs: st.mtimeMs,
          recs: meta && /^packy/.test(meta.model_provider || '') ? parse(fs.readFileSync(file, 'utf8')) : [] };
        packyCache.set(file, c);
      } catch { continue; }
    }
    for (const r of c.recs) {
      if (r.end < since) continue;
      if (r.id) {
        if (ids.has(r.id)) continue;
        ids.add(r.id);
      }
      out.push({ ...r, file });
    }
  }
  return out;
}

module.exports = { records, packyRecords, parse };
