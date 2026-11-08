'use strict';

// Packy 卡片的数据。账单接口只给累计用量，今天和近 7 天靠本地定时采样相减。
// 地址取 ~/.codex/config.toml 的 packy_sol，key 取 PACKYCODE_API_KEY，只发给这个地址，不写进快照；缺一个就不显示卡片。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { DIR, CODEX_HOME, atomicWrite, snapshot, codexAuth } = require('./board-config');
const { packyRecords } = require('./codex-usage');

const LOG = path.join(DIR, 'packy-usage.log');
const SAMPLE_GAP = 300, KEEP = 8 * 86400, TRIM_AT = 128 << 10;
const UNLIMITED = 1e8; // 不限额的令牌，接口把上限填成这个数
const ROUTER_PORT = Number(process.env.PACKY_ROUTER_PORT || 8402);

function baseUrl() {
  let text;
  try { text = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8'); } catch { return null; }
  const start = text.indexOf('[model_providers.packy_sol]');
  if (start < 0) return null;
  const section = text.slice(start).split(/^\[/m)[1] || '';
  const url = (section.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m) || [])[1];
  return url ? url.replace(/\/+$/, '') : null;
}

async function getJson(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readSamples() {
  let text;
  try { text = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
  return text.split('\n').map((line) => line.split('\t').map(Number))
    .filter(([at, total]) => Number.isFinite(at) && Number.isFinite(total) && at > 0)
    .map(([at, total]) => ({ at, total })).sort((a, b) => a.at - b.at);
}

function addSample(list, at, total) {
  const last = list[list.length - 1];
  if (last && at - last.at < SAMPLE_GAP) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(LOG, `${Math.floor(at)}\t${total.toFixed(4)}\n`);
  list.push({ at: Math.floor(at), total });
  if (fs.statSync(LOG).size < TRIM_AT) return;
  const kept = list.filter((s) => s.at >= at - KEEP);
  atomicWrite(LOG, kept.map((s) => `${s.at}\t${s.total.toFixed(4)}\n`).join(''));
}

// 窗口起点之前最后一个采样做基线；采样还没覆盖到起点时从最早的采样算，partial 标出来
function spent(list, from, total) {
  if (!list.length) return null;
  let base = null;
  for (const s of list) {
    if (s.at > from) break;
    base = s;
  }
  const partial = !base;
  if (!base) base = list[0];
  return { usd: Math.max(0, total - base.total), since: partial ? base.at : from, partial };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function codexRuns(since) {
  const runs = { sessions: 0, input: 0, cached: 0, output: 0 }, files = new Set();
  for (const r of packyRecords(since)) {
    files.add(r.file);
    runs.input += (r.u && r.u.input_tokens) || 0;
    runs.cached += (r.u && r.u.cached_input_tokens) || 0;
    runs.output += (r.u && r.u.output_tokens) || 0;
  }
  runs.sessions = files.size;
  return runs;
}

async function compute() {
  const key = process.env.PACKYCODE_API_KEY, base = baseUrl();
  const at = Date.now() / 1000;
  if (!key || !base) return { at, status: 'off' };
  const midnight = new Date(at * 1000);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime() / 1000, list = readSamples();
  const value = { at, status: 'ok', route: codexAuth() ? 'subscription' : 'packy',
    router: await portOpen(ROUTER_PORT), routerPort: ROUTER_PORT };
  try { value.runs = codexRuns(today); } catch {}
  try {
    const [usage, sub] = await Promise.all([getJson(`${base}/dashboard/billing/usage`, key), getJson(`${base}/dashboard/billing/subscription`, key)]);
    // total_usage 的单位是美分：实测一次已知 token 的请求，增量和按价算的金额对得上
    if (!Number.isFinite(usage.total_usage)) throw new Error('账单接口没有返回用量');
    const total = usage.total_usage / 100;
    addSample(list, at, total);
    value.total = total;
    value.limit = Number.isFinite(sub.hard_limit_usd) && sub.hard_limit_usd < UNLIMITED ? sub.hard_limit_usd : null;
    value.today = spent(list, today, total);
    value.week = spent(list, at - 7 * 86400, total);
  } catch (error) {
    value.status = 'error';
    value.message = error.name === 'TimeoutError' ? '账单接口超时' : `账单接口读取失败：${(error.cause && error.cause.code) || error.message}`;
  }
  return snapshot('packy', value, 'PACKY');
}

module.exports = { compute, baseUrl, spent };
