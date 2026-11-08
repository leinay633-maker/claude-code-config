'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { records } = require('./codex-usage');
const { windowStart } = require('./claude-cost');
const { DIR, CODEX_HOME, readJson, codexAuth } = require('./board-config');

// 美元 / 百万 token：输入、缓存读、缓存写、输出。输出包含推理 token。
const PRICES = {
  'gpt-6.1-sol': [2, 0.1, 2.5, 10],
  'gpt-6.1-terra': [1, 0.05, 1.25, 5],
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
};

function price(model, u, turn = false, tier = null) {
  const p = PRICES[model];
  if (!p || !u) return null;
  const [inp, rd, wr, out] = p;
  const all = u.input_tokens || 0, cached = u.cached_input_tokens || 0, write = u.cache_write_input_tokens || 0;
  const fresh = Math.max(0, all - cached - write);
  const long = !turn && all > 272000;
  const k = tier === 'fast' || tier === 'priority' ? 2 : 1;
  return ((fresh * inp + cached * rd + write * wr) * (long ? 2 : 1) +
    (u.output_tokens || 0) * out * (long ? 1.5 : 1)) * k / 1e6;
}

function configTier() {
  try {
    const head = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return (head.match(/^service_tier\s*=\s*["']([^"']+)["']/m) || [])[1] || null;
  } catch { return null; }
}

const MINS = { five: 300, week: 10080 };

function ledger(since, now = Date.now() / 1000, accountKey = codexAuth()?.key) {
  if (!accountKey) return [];
  let text;
  try { text = fs.readFileSync(path.join(DIR, 'codex-ledger.log'), 'utf8').replace(/^\uFEFF/, ''); }
  catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split('\t');
    if (p.length !== 7 || p[1] !== 'warmup' || !p[2] || p[6] !== accountKey) continue;
    const end = Number(p[0]), tokens = p.slice(3, 6).map(Number);
    if (!Number.isFinite(end) || end < since || end > now + 5 ||
      p.slice(3, 6).some((v) => !v.trim()) || !tokens.every((v) => Number.isSafeInteger(v) && v >= 0) || tokens[1] > tokens[0]) continue;
    out.push({ end, model: p[2], tier: null,
      u: { input_tokens: tokens[0], cached_input_tokens: tokens[1], output_tokens: tokens[2] } });
  }
  return out;
}

function compute(snap) {
  const now = Date.now() / 1000, main = (snap && snap.main) || {};
  const pick = (mins) => [main.primary, main.secondary].find((w) => w && w.mins === mins);
  const wins = {};
  for (const [n, mins] of Object.entries(MINS)) wins[n] = windowStart(pick(mins), mins * 60, now);
  const res = { at: Math.floor(now), wins, five: null, week: null, fiveLedger: null, weekLedger: null,
    n: 0, unpriced: [], tierEstimated: false };
  const auth = codexAuth();
  if (!auth || !snap || snap.accountKey !== auth.key) return res;
  const starts = Object.values(wins).filter((x) => x != null);
  if (!starts.length) return res;
  for (const n of Object.keys(MINS)) if (wins[n] != null) { res[n] = 0; res[n + 'Ledger'] = 0; }
  const cfg = configTier(), unpriced = new Set();
  const since = Math.min(...starts);
  // 预热请求不落会话记录；账本按整轮用量计价，不能套用单次长输入加价。
  const rows = [...records(since), ...ledger(since, now, auth.key).map((r) => ({ ...r, turn: true }))];
  for (const r of rows) {
    // 历史记录未写档位时用当前配置估算，不套用特定机器的档位切换时间。
    const tier = r.tier || cfg;
    if (!r.tier) res.tierEstimated = true;
    const usd = price(r.model, r.u, !!r.turn, tier);
    if (usd == null) { unpriced.add(String(r.model)); continue; }
    res.n++;
    for (const n of Object.keys(MINS)) if (wins[n] != null && r.end >= wins[n]) {
      res[n] += usd;
      if (r.turn) res[n + 'Ledger'] += usd;
    }
  }
  res.unpriced = [...unpriced];
  return res;
}

module.exports = { compute, price, configTier, ledger };

if (require.main === module) console.log(JSON.stringify(compute(readJson(path.join(DIR, 'codex.json'))), null, 2));
