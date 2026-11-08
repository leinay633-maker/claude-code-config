'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const SOURCE_NAMES = fs.readdirSync(ROOT).sort();
const TESTS = path.resolve(os.tmpdir());
const RUN = fs.mkdtempSync(path.join(TESTS, 'claude-board-test-'));
const HOME = path.join(RUN, 'home'), BOARD = path.join(RUN, 'board'), BIN = path.join(RUN, 'bin');
for (const dir of [HOME, BOARD, BIN]) fs.mkdirSync(dir, { recursive: true });
const now = Math.floor(Date.now() / 1000), PORT = 8419;
const phases = [], checks = [];
const ACCOUNT_ID = 'sample-subscription';
const fingerprint = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
const ACCOUNT_KEY = fingerprint(ACCOUNT_ID), OTHER_KEY = fingerprint('other-subscription');
let server, killed = false;

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function check(name, fn) { fn(); checks.push(name); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function line(t, type, payload, ordinal) {
  return JSON.stringify({ timestamp: new Date(t * 1000).toISOString(), ...(ordinal == null ? {} : { ordinal }), type, payload });
}
function marker(config, sid) {
  const file = path.join(HOME, config, 'session-env', sid, 'entry');
  write(file, '');
  fs.utimesSync(file, now - 1000, now - 1000);
}
function assistant(t, sid, id, n, request = `req_${id}`) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(t * 1000).toISOString(), sessionId: sid,
    requestId: request, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: n } } });
}
function sent(t, sid) {
  return JSON.stringify({ type: 'api-request', timestamp: new Date(t * 1000).toISOString(), sessionId: sid, querySource: 'repl_main_thread' });
}
function warmup(id, value) {
  write(path.join(BOARD, `warmup-${id}.js`), `(window.WARMUP=window.WARMUP||{})[${JSON.stringify(id)}]=${JSON.stringify(value)};\n`);
}

const accountList = [{ id: 'a', configDir: null }, { id: 'extra-2', configDir: '.claude-extra-2' }];
const subs = now - 90 * 86400;
const windows = { five: { pct: 42, reset: now + 3600 }, week: { pct: 17, reset: now + 86400 } };
function fixtures() {
  write(path.join(BOARD, 'accounts.json'), '\uFEFF' + JSON.stringify({ accounts: accountList }));
  write(path.join(BOARD, 'accounts.js'), `window.ACCOUNTS=${JSON.stringify(accountList)};\n`);
  for (const [i, a] of accountList.entries()) {
    const snap = { acct: a.id, email: `${i ? 'extra' : 'main'}@example.invalid`, sub: subs, ...windows, at: now };
    write(path.join(BOARD, `acct-${a.id}.json`), snap);
    write(path.join(BOARD, `acct-${a.id}.js`), `(window.ACCTS=window.ACCTS||{})[${JSON.stringify(a.id)}]=${JSON.stringify(snap)};\n`);
    const login = a.configDir ? path.join(HOME, a.configDir, '.claude.json') : path.join(HOME, '.claude.json');
    write(login, { oauthAccount: { emailAddress: snap.email, subscriptionCreatedAt: new Date(subs * 1000).toISOString() } });
  }
  write(path.join(HOME, '.claude', '.claude.json'), { oauthAccount: { emailAddress: 'wrong@example.invalid' } });
  warmup('a', { at: now - 15, status: 'ok', msg: 'hi <ready> & safe', alive: now - 15 });
  warmup('codex', { at: now - 10, status: 'skip', msg: '窗口仍有效，跳过', alive: now - 100 });
  const codexLedger = [
    [now - 30, 'warmup', 'gpt-6-luna', 1000, 200, 100, ACCOUNT_KEY],
    [now - 20000, 'warmup', 'gpt-6.1-terra', 1000, 200, 100, ACCOUNT_KEY],
    [now - 30, 'other', 'gpt-6-astra', 1000000, 0, 1000000, ACCOUNT_KEY],
    [now - 30, 'warmup', 'gpt-6-luna', -1, 0, 100, ACCOUNT_KEY],
    [now + 600, 'warmup', 'gpt-6-luna', 1000, 200, 100, ACCOUNT_KEY],
    [now - 8 * 86400, 'warmup', 'gpt-6-luna', 1000, 200, 100, ACCOUNT_KEY],
    [now - 30, 'warmup', 'gpt-6-astra', 1000000, 0, 1000000, OTHER_KEY],
    [now - 30, 'warmup', 'gpt-6-astra', 1000000, 0, 1000000],
  ];
  write(path.join(BOARD, 'codex-ledger.log'), codexLedger.map((row) => row.join('\t')).join('\r\n') + '\r\ninvalid\r\n');
  marker('.claude', 'shared');
  const ledger = [
    [now - 500, 'a', 'shared', 0], [now - 300, 'a', 'shared', 0.02],
    [now - 260, 'extra-2', 'shared', 0], [now - 200, 'extra-2', 'shared', 0.03],
    [now - 50, 'unknown-id', 'shared', 999], [now - 50, 'a', 'shared', -1],
  ];
  write(path.join(BOARD, `ledger-${new Date().toISOString().slice(0, 7)}.log`),
    ledger.map(([t, id, sid, value]) => [t, id, sid, value.toFixed(6)].join('\t')).join('\n') + '\ninvalid\n');
  const messages = [
    sent(now - 530, 'shared'), assistant(now - 525, 'shared', 'before', 300),
    sent(now - 340, 'shared'), assistant(now - 510, 'shared', 'before', 400),
    assistant(now - 320, 'shared', 'covered-a', 500), sent(now - 240, 'shared'),
    assistant(now - 220, 'shared', 'covered-b', 500), sent(now - 140, 'shared'),
    assistant(now - 120, 'shared', 'after', 600),
  ];
  write(path.join(HOME, '.claude', 'projects', 'sample', 'shared.jsonl'), messages.join('\n') + '\n');
  marker('.claude-extra-2', 'dir-only');
  marker('.claude-extra-2', 'short-only');
  write(path.join(HOME, '.claude', 'projects', 'sample', 'extra.jsonl'), [
    sent(now - 90, 'dir-only'), assistant(now - 70, 'dir-only', 'directory', 300),
    sent(now - 50, 'short-only'), assistant(now - 45, 'short-only', 'short', 50),
    assistant(now - 40, 'short-only', 'skip', 50000, 'unrecognized'),
  ].join('\n') + '\n');

  const accountId = ACCOUNT_ID;
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } })).toString('base64url');
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'sample-access', id_token: `e30.${claims}.sample`, account_id: accountId } };
  write(path.join(HOME, '.codex', 'auth.json'), auth);
  write(path.join(HOME, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  const meta = (provider = 'openai', id = accountId) => ({ model_provider: provider, ...(id ? { creator_account_id: id } : {}) });
  const requests = (head) => [
    line(now - 100, 'session_meta', head, 1),
    line(now - 95, 'turn_context', { model: 'gpt-6.1-sol', service_tier: 'priority' }, 2),
    line(now - 90, 'event_msg', { type: 'user_message' }, 3),
    line(now - 80, 'token_usage_record', { response_id: 'response-one', usage: {
      input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 100, output_tokens: 400 } }, 4),
    line(now - 70, 'response_item', { type: 'function_call_output', output: '' }, 5),
    line(now - 60, 'token_usage_record', { response_id: 'response-two', usage: {
      input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 600 } }, 6),
  ].join('\n') + '\n';
  const sessions = path.join(HOME, '.codex', 'sessions');
  write(path.join(sessions, 'rollout-main.jsonl'), requests(meta()));
  write(path.join(sessions, 'rollout-fork.jsonl'), requests(meta()));
  write(path.join(sessions, 'rollout-excluded.jsonl'), requests(meta('other')));
  write(path.join(sessions, 'rollout-other-account.jsonl'), requests(meta('openai', 'other-subscription')));
  write(path.join(sessions, 'rollout-key.jsonl'), requests(meta('openai', null)));
  write(path.join(HOME, '.codex', 'archived_sessions', 'rollout-legacy.jsonl'), [
    line(now - 60, 'session_meta', meta()), line(now - 55, 'turn_context', { model: 'gpt-6.1-terra' }),
    line(now - 50, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1100 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } } }),
    line(now - 49, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1100 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } } }),
  ].join('\n') + '\n');
  write(path.join(BIN, 'limits.json'), { rateLimits: { planType: 'plus', limitId: 'codex',
    primary: { usedPercent: 21, resetsAt: now + 3600, windowDurationMins: 300 },
    secondary: { usedPercent: 12, resetsAt: now + 86400, windowDurationMins: 10080 } } });
  write(path.join(BIN, 'codex.cmd'), '@echo off\r\nnode "%~dp0mock-app-server.js"\r\n');
  write(path.join(BIN, 'mock-app-server.js'), `
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, 'rpc.log'), m.method + '\\n');
  if (m.method === 'initialize') reply(m.id, {});
  else if (m.method === 'account/login/start') reply(m.id, { type: 'chatgptAuthTokens' });
  else if (m.method === 'account/read') reply(m.id, { account: { type: 'chatgpt', planType: 'plus' } });
  else if (m.method === 'account/rateLimits/read') reply(m.id, JSON.parse(fs.readFileSync(path.join(__dirname, 'limits.json'), 'utf8')));
});
`);
  return auth;
}

async function vacant() {
  const socket = net.createServer();
  socket.listen(PORT, '127.0.0.1');
  await once(socket, 'listening');
  await new Promise((resolve) => socket.close(resolve));
}

async function start() {
  await vacant();
  server = spawn(process.execPath, [path.join(ROOT, 'board-server.js')], {
    cwd: ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  write(path.join(RUN, 'server-pid.json'), { pid: server.pid, port: PORT, stopped: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务启动超时')), 10000);
    server.once('error', reject);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('测试服务提前退出')); });
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`127.0.0.1:${PORT}`)) { clearTimeout(timer); resolve(); }
    });
  });
}
async function api(route, options = {}) {
  const headers = { Origin: `http://127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin', ...options.headers };
  for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key];
  return fetch(`http://127.0.0.1:${PORT}${route}`, { ...options, headers });
}
function rawRequest(route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: PORT, path: route, method,
      setHost: false, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}
async function data(route) {
  const response = await api(route);
  assert.equal(response.status, 200, route);
  return response.json();
}

async function page(dir, online, search = '?port=8419') {
  const elements = Object.fromEntries(['hero', 'queue', 'grid', 'others', 'now', 'status', 'offline-hint', 'live-url']
    .map((id) => [id, { innerHTML: '', textContent: '', hidden: true }]));
  const urls = [], scripts = [];
  const origin = `http://127.0.0.1:${PORT}`;
  let context;
  const document = {
    createElement: () => ({ remove() {} }),
    head: { appendChild(script) {
      scripts.push(script.src.split('?')[0]);
      queueMicrotask(async () => {
        let code;
        if (online) {
          const response = await fetch(new URL(script.src, origin + '/'), { headers: { 'Sec-Fetch-Site': 'same-origin' } });
          if (!response.ok) return script.onerror();
          code = await response.text();
        } else {
          const file = path.join(dir, script.src.split('?')[0]);
          if (!fs.existsSync(file)) return script.onerror();
          code = fs.readFileSync(file, 'utf8');
        }
        vm.runInContext(code, context);
        script.onload();
      });
    } },
    getElementById: (id) => elements[id], addEventListener() {},
  };
  const globals = { document, Date, Intl, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval() {},
    location: { protocol: online ? 'http:' : 'file:', origin: online ? origin : 'null', search, reload() {} },
    fetch: async (url, options) => {
      urls.push(url);
      if (!online) throw new TypeError('offline');
      return fetch(url, { ...options, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
    } };
  globals.window = globals;
  context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'order.js'), 'utf8'), context);
  await vm.runInContext(fs.readFileSync(path.join(ROOT, 'board.js'), 'utf8'), context);
  return { elements, urls, scripts };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('自测仅支持 Windows');
  const auth = fixtures();
  Object.assign(process.env, { USERPROFILE: HOME, HOME, CLAUDE_BOARD_DIR: BOARD, CLAUDE_BOARD_PORT: String(PORT),
    PATH: [BIN, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) });
  assert.equal(os.homedir(), HOME);
  const config = require('./board-config'), cost = require('./claude-cost'), speed = require('./model-speed');
  const cxCost = require('./codex-cost'), usage = require('./codex-usage'), snapshot = require('./codex-snapshot');

  check('默认目录与环境变量覆盖', () => {
    assert.equal(config.DIR, BOARD);
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("./board-config").DIR)'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_BOARD_DIR: '' },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, path.join(HOME, '.claude', 'board'));
  });
  check('主副账号登录文件与 BOM 清单', () => {
    assert.equal(config.accounts().length, 2);
    assert.equal(config.readAccount(accountList[0]).email, 'main@example.invalid');
    assert.equal(config.readAccount(accountList[1]).email, 'extra@example.invalid');
  });
  check('原有模型价格、缓存、长输入和 fast 计价', () => {
    near(cost.price('claude-opus-5-5[1m]', { input_tokens: 1000, output_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 }, cache_read_input_tokens: 1000,
      speed: 'fast', server_tool_use: { web_search_requests: 1 } }), 0.0844);
    near(cost.price('claude-haiku-5-5', { input_tokens: 100001 }), 0.0500005);
    near(cost.price('claude-sonnet-5-5', { cache_read_input_tokens: 1000000 }), 0.1);
    near(cost.price('claude-opus-5-5', { cache_read_input_tokens: 1000000 }), 0.2);
    near(cxCost.price('gpt-6.1-sol', { input_tokens: 300000, output_tokens: 1000 }, false, 'priority'), 2.43);
    assert.equal(cost.price('unknown', {}), null);
    assert.equal(cxCost.price('unknown', {}), null);
  });
  check('重置边界与多月续接归属', () => {
    assert.equal(cost.windowStart({ reset: now - 1 }, 18000, now), now - 1);
    assert.equal(cost.windowStart({ reset: now - 18001 }, 18000, now), null);
    assert.equal(cost.owner([[10, 'a'], [20, 'extra-2']], 30), 'extra-2');
  });
  check('只清理查询自身的目录，并处理只读文件', () => {
    const runtime = fs.mkdtempSync(path.join(BOARD, '.codex-reader-'));
    const file = path.join(runtime, 'readonly');
    write(file, 'sample'); fs.chmodSync(file, 0o400);
    snapshot.removeRuntime(runtime);
    assert.equal(fs.existsSync(runtime), false);
    assert.throws(() => snapshot.removeRuntime(HOME));
  });
  await start();
  const list = await data('/accounts'), dollars = await data('/cost'), rates = await data('/speed');
  check('账号接口动态读取、只返回声明账号', () => {
    assert.deepEqual(list.accounts, accountList);
    assert.deepEqual(Object.keys(list.accts), ['a', 'extra-2']);
    assert.equal(list.accts.a.email, 'main@example.invalid');
    assert.equal(list.port, PORT);
  });
  check('花费补算、流式去重、账本优先和跨账号归属', () => {
    near(dollars.accts.a.five, 0.032); near(dollars.accts['extra-2'].five, 0.061);
    near(dollars.accts.a.week, 0.032); near(dollars.accts.a.fiveEst, 0.012);
    assert.equal(Object.keys(dollars.accts).length, 2);
  });
  write(path.join(BOARD, 'cost-cache.json'), { v: 3, files: {},
    msgs: { obsolete: [now - 100, 'shared', 'claude-opus-5-5', 99, 200] } });
  const migrated = cost.compute();
  check('单价版本升级后丢弃旧金额缓存', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(BOARD, 'cost-cache.json'), 'utf8')).v, 4);
    near(migrated.accts.a.five, dollars.accts.a.five);
    near(migrated.accts['extra-2'].five, dollars.accts['extra-2'].five);
  });
  const ledgerFile = path.join(BOARD, `ledger-${new Date().toISOString().slice(0, 7)}.log`);
  const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
  fs.appendFileSync(ledgerFile, [
    `${now - 100}\ta\tbaseline-only\t0.000000`, `${now - 100}\ta\tbaseline-only\t0.004000`,
    `${now - 80}\ta\tbaseline-only\t0.000000`, `${now - 70}\ta\tbaseline-only\t0.006000`,
  ].join('\n') + '\n');
  const baselineCost = cost.compute();
  check('进程首行零基线不收费，同秒和后续增量均正常累加', () => {
    near(baselineCost.accts.a.five - dollars.accts.a.five, 0.01);
    near(baselineCost.accts.a.week - dollars.accts.a.week, 0.01);
  });
  write(ledgerFile, ledgerBefore);
  cost.compute();
  check('速度按总输出除总耗时、过滤短回复', () => {
    assert.equal(rates.accts.a.models[0].out, 900);
    assert.equal(rates.accts.a.models[0].dur, 40);
    assert.equal(rates.accts['extra-2'].models[0].n, 3);
    assert.equal(rates.codex.models[0].out, 1000); assert.equal(rates.codex.models[0].dur, 20);
    assert.deepEqual(speed.aggregate([{ model: 'sample', out: 50, dur: 5 }]), { models: [], short: 1 });
  });
  const [cx, cxAgain] = await Promise.all([data('/codex'), data('/codex')]);
  check('Codex 官方订阅过滤、去重、旧格式与窗口计价', () => {
    assert.equal(cx.status, 'ok'); assert.equal(cx.auth, 'chatgpt');
    assert.deepEqual(cx, cxAgain); assert.equal(cx.cost.n, 5); near(cx.cost.five, 0.030424);
    assert.equal(cx.cost.tierEstimated, true);
    const calls = fs.readFileSync(path.join(BIN, 'rpc.log'), 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['initialize', 'initialized', 'account/login/start', 'account/read', 'account/rateLimits/read']);
    assert.ok(!fs.readdirSync(BOARD).some((f) => f.startsWith('.codex-reader-')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'auth.json'), 'utf8')), auth);
  });
  check('预热账本只认当前指纹，旧格式及其他账号均不计入', () => {
    assert.equal(config.codexAuth().key, ACCOUNT_KEY);
    assert.equal(cxCost.ledger(now - 7 * 86400).length, 2);
    near(cx.cost.fiveLedger, 0.000264); near(cx.cost.weekLedger, 0.002884);
    near(cx.cost.week, 0.033044);
    near(cxCost.compute(cx).five, cx.cost.five);
    near(cxCost.price('gpt-6.1-sol', { input_tokens: 300000, output_tokens: 1000 }, true, 'priority'), 1.22);
  });
  const snapBeforeRaw = fs.readFileSync(path.join(BOARD, 'codex.json'), 'utf8');
  const raw = spawnSync(process.execPath, [path.join(ROOT, 'codex-snapshot.js'), '--raw'], {
    cwd: ROOT, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  check('raw 输出原始额度 JSON，且不写普通快照', () => {
    assert.equal(raw.status, 0, raw.stderr);
    const result = JSON.parse(raw.stdout);
    assert.equal(result.rateLimits.primary.windowDurationMins, 300);
    assert.equal(result.rateLimits.secondary.windowDurationMins, 10080);
    assert.equal(result.rateLimits.primary.resetsAt, now + 3600);
    assert.equal(result.rateLimits.primary.usedPercent, 21);
    assert.equal(Object.hasOwn(result, 'main'), false);
    assert.equal(fs.readFileSync(path.join(BOARD, 'codex.json'), 'utf8'), snapBeforeRaw);
    assert.ok(!fs.readdirSync(BOARD).some((f) => f.startsWith('.codex-reader-')));
  });
  write(path.join(RUN, 'raw-mock.json'), raw.stdout);
  check('Codex 缓存跟随订阅账号切换', () => {
    const changed = { ...auth, tokens: { ...auth.tokens, account_id: 'other-subscription' } };
    write(path.join(HOME, '.codex', 'auth.json'), changed);
    assert.equal(usage.records(now - 3600).length, 2);
    assert.equal(cxCost.ledger(now - 7 * 86400).length, 1);
    const otherCost = cxCost.compute({ ...cx, accountKey: OTHER_KEY });
    near(otherCost.fiveLedger, 120);
    write(path.join(HOME, '.codex', 'auth.json'), auth);
    assert.equal(usage.records(now - 3600).length, 3);
    assert.equal(cxCost.ledger(now - 7 * 86400).length, 2);
  });

  const preflight = await api('/cost', { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
  const denied = await api('/accounts', { headers: { Origin: 'https://example.invalid' } });
  const notFound = await api('/removed-endpoint'), post = await api('/cost', { method: 'POST' });
  check('本机来源、预检、未知接口与写入方法', () => {
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'), null);
    assert.equal(denied.status, 403); assert.equal(notFound.status, 404); assert.equal(post.status, 405);
  });
  const host = `127.0.0.1:${PORT}`, origin = `http://${host}`;
  const validHeaders = [
    { Host: host }, { Host: host, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    { Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}`, 'Sec-Fetch-Site': 'none' },
    { Host: host, 'Sec-Fetch-Site': 'none' },
  ];
  for (const headers of validHeaders) {
    const result = await rawRequest('/accounts', headers);
    assert.equal(result.status, 200);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  }
  checks.push('精确本机 Host 和 Origin 白名单，允许无来源头的本机请求');
  const badHeaders = [
    {}, { Host: 'example.invalid' }, { Host: `127.0.0.1:${PORT + 1}` },
    { Host: host, Origin: 'null' }, { Host: host, Origin: '' },
    { Host: host, Origin: 'https://example.invalid' },
    { Host: host, Origin: `http://localhost:${PORT + 1}` },
    { Host: host, Origin: `https://127.0.0.1:${PORT}` },
    { Host: host, 'Sec-Fetch-Site': 'cross-site' },
    { Host: host, 'Sec-Fetch-Site': 'same-site' },
    { Host: host, 'Sec-Fetch-Site': '' },
    { Host: host, Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const route of ['/accounts', '/cost', '/speed', '/codex', '/acct-a.js', '/warmup-a.js', '/accounts.js', '/']) {
    for (const headers of badHeaders) {
      const result = await rawRequest(route, headers);
      assert.equal(result.status, 403, route + ' ' + JSON.stringify(headers));
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.ok(!result.body.includes('main@example.invalid'));
    }
  }
  checks.push('全部数据和脚本入口拒绝 null、跨站脚本、其他端口、错误主机及同站跨源请求');
  const nav = { Host: host, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const route of ['/', '/index.html', '/?port=8419']) assert.equal((await rawRequest(route, nav)).status, 200, route);
  for (const route of ['/accounts', '/cost', '/board.js', '/acct-a.js', '/accounts.js']) {
    assert.equal((await rawRequest(route, nav)).status, 403, route);
  }
  for (const dest of ['iframe', 'script', 'empty']) {
    assert.equal((await rawRequest('/', { ...nav, 'Sec-Fetch-Dest': dest })).status, 403, dest);
  }
  assert.equal((await rawRequest('/', { ...nav, Host: 'example.invalid' })).status, 403);
  checks.push('跨站点开看板页面放行，嵌入、脚本和数据接口仍拒绝');
  for (const route of ['/', '/index.html', '/board.js', '/order.js', '/accounts.js', '/acct-extra-2.js', '/cost.js', '/speed.js', '/codex.js', '/warmup-a.js', '/warmup-codex.js']) {
    assert.equal((await api(route)).status, 200, route);
  }
  write(path.join(BOARD, 'warmup-unknown-id.js'), 'window.TEST=true;');
  for (const route of ['/cost-cache.json', '/ledger-2026-01.log', '/codex-ledger.log', '/self-test.js', '/.codex-reader-secret/auth.json', '/warmup-unknown-id.js', '/warmup-extra-2.js']) {
    assert.equal((await api(route)).status, 404, route);
  }
  for (const route of ['/../acct-a.js', '/nested/../acct-a.js', '/%2e%2e/acct-a.js', '/nested/%2e%2e/acct-a.js',
    '/..%2facct-a.js', '/.%2e%5cacct-a.js', '//acct-a.js', '/nested/acct-a.js']) {
    const result = await rawRequest(route, { Host: host });
    assert.equal(result.status, 404, route);
  }
  const directoryAsset = path.join(BOARD, 'warmup-extra-2.js');
  fs.mkdirSync(directoryAsset);
  assert.equal((await api('/warmup-extra-2.js')).status, 404);
  fs.rmdirSync(directoryAsset);
  const front = await api('/');
  assert.match(await front.text(), /<script src="order\.js"><\/script>\s*<script src="board\.js"><\/script>/);
  checks.push('静态资源白名单');

  const online = await page(BOARD, true);
  const offline = await page(BOARD, false);
  check('页面在线及 file 快照、连字符账号与自定义端口', () => {
    for (const result of [online, offline]) {
      assert.equal((result.elements.grid.innerHTML.match(/data-account=/g) || []).length, 2);
      assert.ok(result.elements.grid.innerHTML.includes('EXTRA-2'));
      assert.ok(result.elements.grid.innerHTML.includes('$0.03'));
      assert.ok(result.elements.grid.innerHTML.includes('$0.06'));
    }
    assert.equal(online.urls.length, 4);
    assert.ok(online.urls.every((url) => url.startsWith('http://127.0.0.1:8419/')));
    assert.equal(offline.urls.length, 0);
    assert.equal(online.elements.status.textContent, '实时数据已更新');
    assert.ok(offline.elements.status.textContent.includes('离线模式'));
    assert.equal(offline.elements['offline-hint'].hidden, false);
    assert.equal(offline.elements['live-url'].href, 'http://127.0.0.1:8419/');
    assert.equal(offline.elements['live-url'].textContent, 'http://127.0.0.1:8419/');
    assert.equal(online.elements['offline-hint'].hidden, true);
    assert.ok(offline.elements.others.innerHTML.includes('快照'));
  });
  const customLink = await page(BOARD, false, '?port=8427');
  const defaultLink = await page(BOARD, false, '');
  const invalidLink = await page(BOARD, false, '?port=70000');
  const ownOrigin = await page(BOARD, true, '?port=8427');
  check('file 的端口只改提示链接，HTTP 始终请求本页同源服务', () => {
    assert.equal(customLink.elements['live-url'].href, 'http://127.0.0.1:8427/');
    assert.equal(defaultLink.elements['live-url'].href, 'http://127.0.0.1:8411/');
    assert.equal(invalidLink.elements['live-url'].href, 'http://127.0.0.1:8411/');
    for (const result of [customLink, defaultLink, invalidLink]) assert.equal(result.urls.length, 0);
    assert.ok(ownOrigin.urls.every((url) => url.startsWith('http://127.0.0.1:8419/')));
  });
  check('账号及 Codex 预热快照在线离线显示，缺失文件静默跳过', () => {
    for (const result of [online, offline]) {
      assert.equal((result.elements.grid.innerHTML.match(/class="warmup"/g) || []).length, 1);
      assert.ok(result.elements.grid.innerHTML.includes('hi &lt;ready&gt; &amp; safe'));
      assert.ok(result.elements.grid.innerHTML.includes('>成功</span>'));
      assert.ok(result.elements.others.innerHTML.includes('窗口仍有效，跳过'));
      assert.ok(result.elements.others.innerHTML.includes('>跳过</span>'));
      assert.ok(result.scripts.includes('warmup-a.js'));
      assert.ok(result.scripts.includes('warmup-extra-2.js'));
      assert.ok(result.scripts.includes('warmup-codex.js'));
      assert.ok(result.elements.others.innerHTML.includes('其中预热补记'));
    }
  });
  const savedAccountsJs = fs.readFileSync(path.join(BOARD, 'accounts.js'), 'utf8');
  write(path.join(BOARD, 'accounts.js'), `window.ACCOUNTS=${JSON.stringify(accountList.slice(0, 1))};`);
  warmup('extra-2', { at: now - 5, status: 'limit', msg: 'weekly usage limit', alive: now - 5 });
  const dynamic = await page(BOARD, true);
  check('服务端账号清单新增的账号也加载对应预热快照', () => {
    assert.ok(dynamic.scripts.includes('warmup-extra-2.js'));
    assert.equal((dynamic.elements.grid.innerHTML.match(/class="warmup"/g) || []).length, 2);
    assert.ok(dynamic.elements.grid.innerHTML.includes('本周额度已满'));
  });
  write(path.join(BOARD, 'accounts.js'), savedAccountsJs);

  const savedAccount = fs.readFileSync(path.join(BOARD, 'acct-a.js'), 'utf8');
  const savedWarmup = fs.readFileSync(path.join(BOARD, 'warmup-a.js'), 'utf8');
  const current = new Date(now * 1000), y = current.getUTCFullYear(), mo = current.getUTCMonth();
  const older = { ...JSON.parse(fs.readFileSync(path.join(BOARD, 'acct-a.json'), 'utf8')),
    sub: Date.UTC(y, mo - 2, 1) / 1000, at: Date.UTC(y, mo - 1, 1) / 1000 + 100 };
  write(path.join(BOARD, 'acct-a.js'), `(window.ACCTS=window.ACCTS||{}).a=${JSON.stringify(older)};`);
  const card = (html) => html.split('data-account="a">')[1].split('data-account=')[0];
  warmup('a', { at: now - 10, status: 'error', msg: 'temporary failure' });
  const staleSubscription = await page(BOARD, false);
  warmup('a', { at: now - 10, status: 'error', msg: 'temporary failure', alive: now - 15 });
  const renewed = await page(BOARD, false);
  check('失败时沿用 alive 顺延订阅到期日', () => {
    assert.ok(card(staleSubscription.elements.grid.innerHTML).includes('class="row sub gone"'));
    assert.ok(!card(renewed.elements.grid.innerHTML).includes('class="row sub gone"'));
    assert.ok(card(renewed.elements.grid.innerHTML).includes('预热证明订阅可用'));
  });
  for (const [status, msg, expected] of [
    ['ok', 'hi', '成功'], ['limit', 'usage limit', '额度已满'], ['error', 'temporary failure', '失败'],
    ['timeout', 'request timeout', '超时'], ['skip', 'window remains active', '跳过'],
    ['error', 'payment is past due', '扣款失败'],
    ['error', 'this login reached its time limit and cannot be renewed', '登录到期'],
    ['ok', 'can end at any time from now until later', '登录随时可能失效'],
  ]) {
    warmup('a', { at: now - 10, status, msg, alive: now - 15 });
    const result = await page(BOARD, false);
    assert.ok(card(result.elements.grid.innerHTML).includes(expected), status + ': ' + expected);
    if (expected === '登录到期') assert.ok(result.elements.hero.innerHTML.includes('EXTRA-2'));
    if (expected === '扣款失败') assert.ok(card(result.elements.grid.innerHTML).includes('class="row sub gone"'));
  }
  checks.push('预热所有状态、扣款失败、登录失效和登录提醒');
  warmup('a', { at: now - 10, status: 'ok', msg: 'hi' });
  const aliveFallback = await page(BOARD, false);
  check('旧快照缺少 alive 时成功时间仍可顺延订阅', () => {
    assert.ok(!card(aliveFallback.elements.grid.innerHTML).includes('class="row sub gone"'));
  });
  warmup('a', { at: now - 10, status: 'error', msg: '<img src=x onerror=1>', alive: now - 15 });
  const safeWarmup = await page(BOARD, false);
  check('预热消息转义', () => {
    assert.ok(safeWarmup.elements.grid.innerHTML.includes('&lt;img'));
    assert.ok(!safeWarmup.elements.grid.innerHTML.includes('<img'));
  });
  write(path.join(BOARD, 'acct-a.js'), savedAccount);
  write(path.join(BOARD, 'warmup-a.js'), savedWarmup);
  const malicious = { ...JSON.parse(fs.readFileSync(path.join(BOARD, 'acct-a.json'), 'utf8')), email: '<img src=x onerror=1>' };
  write(path.join(BOARD, 'acct-a.js'), `(window.ACCTS=window.ACCTS||{}).a=${JSON.stringify(malicious)};`);
  const escaped = await page(BOARD, false);
  check('本地文本转义', () => {
    assert.ok(escaped.elements.grid.innerHTML.includes('&lt;img'));
    assert.ok(!escaped.elements.grid.innerHTML.includes('<img'));
  });
  // 没有额度快照的号也要排进切号顺序，不能让整条顺序消失
  write(path.join(BOARD, 'accounts.js'), `window.ACCOUNTS=${JSON.stringify([...accountList, { id: 'new-3', configDir: '.claude-new-3' }])};`);
  const tagOf = (html, id) => html.split(`data-account="${id}">`)[1].split('data-account=')[0].match(/class="tag[^"]*">([^<]*)</)[1];
  const unranked = await page(BOARD, false);
  warmup('new-3', { at: now - 10, status: 'error', msg: 'Not logged in · Please run /login' });
  const noLogin = await page(BOARD, false);
  warmup('new-3', { at: now - 10, status: 'ok', msg: 'hi', alive: now - 10 });
  const warmed = await page(BOARD, false);
  fs.rmSync(path.join(BOARD, 'warmup-new-3.js'));
  write(path.join(BOARD, 'accounts.js'), `window.ACCOUNTS=${JSON.stringify([{ id: 'new-3', configDir: '.claude-new-3' }])};`);
  const onlyUnknown = await page(BOARD, false);
  write(path.join(BOARD, 'accounts.js'), savedAccountsJs);
  check('没有额度快照的号也排进切号顺序', () => {
    assert.ok(unranked.elements.hero.innerHTML.includes('现在用'));
    assert.ok(unranked.elements.queue.innerHTML.includes('<b>NEW-3</b><small>没有额度快照</small>'));
    assert.equal(tagOf(unranked.elements.grid.innerHTML, 'new-3'), '第 3 个');
    assert.ok(noLogin.elements.queue.innerHTML.includes('<b>NEW-3</b><small>没登录，先登录</small>'));
    assert.ok(warmed.elements.queue.innerHTML.includes('<b>NEW-3</b><small>预热可用 · 额度未知</small>'));
    assert.ok(onlyUnknown.elements.hero.innerHTML.includes('先试') && onlyUnknown.elements.hero.innerHTML.includes('NEW-3'));
  });
  const empty = path.join(RUN, 'empty'); fs.mkdirSync(empty);
  write(path.join(empty, 'accounts.js'), 'window.ACCOUNTS=[];');
  const noData = await page(empty, false);
  check('空安装与服务未启动不抛异常', () => {
    assert.ok(noData.elements.hero.innerHTML.includes('尚未配置账号'));
    assert.ok(noData.elements.others.innerHTML.includes('尚无 Codex 快照'));
    assert.ok(!noData.elements.grid.innerHTML.includes('class="warmup"'));
    assert.ok(!noData.elements.others.innerHTML.includes('class="warmup"'));
  });

  marker('.claude', 'incremental');
  const partial = assistant(now - 20, 'incremental', 'partial', 100), partialFile = path.join(HOME, '.claude', 'projects', 'sample', 'partial.jsonl');
  write(partialFile, partial.slice(0, 80));
  const before = cost.compute().accts.a.five;
  fs.appendFileSync(partialFile, partial.slice(80) + '\n');
  const after = cost.compute().accts.a.five;
  check('未完整行留待下次增量读取，重算不重记', () => {
    near(after - before, 0.006); near(cost.compute().accts.a.five, after);
    const cache = JSON.parse(fs.readFileSync(path.join(BOARD, 'cost-cache.json'), 'utf8'));
    assert.ok(Object.keys(cache.files).every((file) => !path.isAbsolute(file)));
  });
  write(path.join(BOARD, 'accounts.json'), { accounts: [...accountList, { id: 'codex', configDir: '.claude-other' }] });
  const collision = speed.compute();
  check('Claude 账号名与 Codex 卡片互不覆盖', () => {
    assert.equal(collision.accts.codex, null); assert.ok(collision.codex.models.length);
  });
  write(path.join(BOARD, 'accounts.json'), { accounts: accountList });
  write(path.join(HOME, '.codex', 'auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: 'sample' });
  const loggedOut = await snapshot.readCodex();
  check('未用订阅登录时不查额度、不计价', () => {
    assert.equal(loggedOut.status, 'not-logged-in'); assert.equal(usage.records(now - 3600).length, 0);
    assert.equal(cxCost.ledger(now - 7 * 86400).length, 0);
  });
  const noSubscription = await page(BOARD, false);
  check('Codex 没有登录时仍显示已有预热记录', () => {
    assert.ok(noSubscription.elements.others.innerHTML.includes('未使用 ChatGPT 订阅登录 Codex'));
    assert.ok(noSubscription.elements.others.innerHTML.includes('窗口仍有效，跳过'));
  });
  const savedPath = process.env.PATH; process.env.PATH = path.dirname(process.execPath);
  const missingRaw = spawnSync(process.execPath, [path.join(ROOT, 'codex-snapshot.js'), '--raw'], {
    cwd: ROOT, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  const absent = await snapshot.readCodex(); process.env.PATH = savedPath;
  check('没有 Codex 安装时返回正常状态', () => assert.equal(absent.status, 'not-installed'));
  check('未安装时 raw 迅速非零退出，不输出伪造 JSON', () => {
    assert.equal(missingRaw.status, 1);
    assert.equal(missingRaw.error, undefined);
    assert.equal(missingRaw.signal, null);
    assert.equal(missingRaw.stdout.trim(), '');
    assert.ok(missingRaw.stderr.includes('未安装 Codex'));
  });
  write(path.join(HOME, '.codex', 'auth.json'), auth);

  const retained = [];
  function jsFiles(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) jsFiles(file); else if (e.name.endsWith('.js')) retained.push(file);
    }
  }
  jsFiles(ROOT);
  jsFiles(RUN);
  for (const file of retained) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, path.relative(ROOT, file));
  }
  checks.push(`全部 ${retained.length} 个 JS 文件语法检查`);
  check('测试不在代码目录生成文件', () => assert.deepEqual(fs.readdirSync(ROOT).sort(), SOURCE_NAMES));
  phases.push('模拟数据与定价', '零基线与金额缓存迁移', '8419 HTTP 接口与来源限制', '模拟官方协议',
    '预热快照与续费推算', '预热账本账号指纹', 'raw CLI 输出', 'HTTP 同源及 file 离线页面', '缺失安装和登录', '语法检查');
  write(path.join(RUN, 'results.json'), { ok: true, checks, phases, browserOpened: false, liveQuotaQueried: false,
    claudeFive: dollars.accts, codexFive: cx.cost.five, codexWeek: cx.cost.week,
    codexFiveLedger: cx.cost.fiveLedger, codexWeekLedger: cx.cost.weekLedger, rawExit: raw.status, missingRawExit: missingRaw.status });
  console.log(`PASS ${checks.length} 组检查；${retained.length} 个 JS 文件语法通过`);
  console.log(JSON.stringify({ phases, codexFive: cx.cost.five, codexWeek: cx.cost.week,
    codexFiveLedger: cx.cost.fiveLedger, codexWeekLedger: cx.cost.weekLedger, rawExit: raw.status, missingRawExit: missingRaw.status }));
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const saved = JSON.parse(fs.readFileSync(path.join(RUN, 'server-pid.json'), 'utf8'));
  assert.equal(saved.pid, server.pid);
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  killed = true;
  write(path.join(RUN, 'server-pid.json'), { ...saved, stopped: true });
  console.log(`测试服务已结束（PID ${saved.pid}）`);
}

function cleanup() {
  const resolved = path.resolve(RUN);
  if (path.dirname(resolved).toLowerCase() !== TESTS.toLowerCase() || !path.basename(resolved).startsWith('claude-board-test-')) {
    throw new Error('无效的测试清理目录');
  }
  function writable(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) writable(path.join(file, name));
    fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
  }
  writable(resolved);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.existsSync(resolved), false);
  console.log('系统临时目录内的测试产物已全部清理');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try {
      await stop();
      if (server && !killed) process.exitCode = 1;
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      try { cleanup(); } catch (error) { console.error(error); process.exitCode = 1; }
    }
  });
