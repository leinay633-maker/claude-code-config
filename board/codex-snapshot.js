'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DIR, codexAuth, snapshot } = require('./board-config');

function findCommand() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ['codex.exe', 'codex.cmd']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name);
      try { if (fs.statSync(file).isFile()) return { file, name }; } catch {}
    }
  }
  return null;
}

function removeRuntime(runtime) {
  const resolved = path.resolve(runtime);
  if (path.dirname(resolved).toLowerCase() !== DIR.toLowerCase() || !path.basename(resolved).startsWith('.codex-reader-')) {
    throw new Error('无效的查询临时目录');
  }
  function writable(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) writable(path.join(file, name));
    fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
  }
  writable(resolved);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// 查询只使用临时配置和内存中的访问令牌，不复制刷新令牌，不写原登录目录。
async function readRaw(auth = codexAuth(), command = findCommand()) {
  if (!command) throw new Error('未安装 Codex');
  if (!auth) throw new Error('请先使用 ChatGPT 订阅登录 Codex');
  fs.mkdirSync(DIR, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(DIR, '.codex-reader-'));
  const env = { ...process.env, CODEX_HOME: runtime, USERPROFILE: runtime, HOME: runtime,
    APPDATA: path.join(runtime, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(runtime, 'AppData', 'Local'),
    TEMP: runtime, TMP: runtime };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_PROFILE']) delete env[key];
  try {
    fs.writeFileSync(path.join(runtime, 'config.toml'), 'model_provider = "openai"\ncli_auth_credentials_store = "file"\n' +
      '[features]\nplugins = false\napps = false\nremote_plugin = false\nhooks = false\ndaemon_auto_start = false\n');
    return await new Promise((resolve, reject) => {
      // 使用明确的扩展名，避免同目录的 codex.js 快照被命令解析器当成 CLI。
      const child = command.name.endsWith('.exe')
        ? spawn(command.file, ['app-server'], { cwd: runtime, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
        : spawn('codex.cmd app-server', { cwd: runtime, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let done = false, closed = false, buffer = '', finishError = null, finishResult;
      let grace;
      const timer = setTimeout(() => finish(new Error('读取 Codex 额度超时')), 30000);

      function settle() {
        clearTimeout(grace);
        if (finishError) reject(finishError); else resolve(finishResult);
      }
      function finish(error, value) {
        if (done) return;
        done = true;
        finishError = error;
        finishResult = value;
        clearTimeout(timer);
        child.stdin.end();
        if (closed) return settle();
        // 正常情况通过 EOF 退出；超时兜底只作用于本次 spawn 返回的 PID。
        grace = setTimeout(() => {
          if (closed || !child.pid) return settle();
          const stop = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          stop.on('error', settle);
          stop.on('close', settle);
        }, 1500);
      }
      function send(message) {
        if (!done) child.stdin.write(JSON.stringify(message) + '\n');
      }
      function handle(message) {
        if (done) return;
        if (message.method === 'account/chatgptAuthTokens/refresh' && message.id != null) {
          send({ id: message.id, error: { code: -32000, message: '请在 Codex 中重新登录后刷新看板' } });
          return finish(new Error('Codex 登录已过期，请重新登录'));
        }
        if (![1, 2, 3, 4].includes(message.id)) return;
        if (message.error) {
          const text = String(message.error.message || '读取失败');
          return finish(new Error(/auth|401|unauthorized|expired/i.test(text)
            ? 'Codex 登录已过期，请重新登录' : '读取 Codex 额度失败'));
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/login/start', params: { type: 'chatgptAuthTokens',
            accessToken: auth.accessToken, chatgptAccountId: auth.accountId, ...(auth.plan ? { chatgptPlanType: auth.plan } : {}) } });
        } else if (message.id === 2) {
          send({ id: 3, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 3) {
          const account = message.result && message.result.account;
          if (!account || account.type !== 'chatgpt') return finish(new Error('请先使用 ChatGPT 订阅登录 Codex'));
          send({ id: 4, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (message.id === 4) finish(null, message.result);
      }
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          handle(message);
        }
      });
      child.stdin.on('error', () => finish(new Error('Codex 查询连接已关闭')));
      child.on('error', () => { closed = true; finish(new Error('无法启动 Codex')); });
      child.on('close', () => {
        closed = true;
        if (done) settle(); else finish(new Error('Codex 查询提前退出'));
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-board', title: 'Claude Board', version: '1.0' },
        capabilities: { experimentalApi: true } } });
    });
  } finally {
    removeRuntime(runtime);
  }
}

function win(w) {
  return w ? { pct: w.usedPercent, reset: w.resetsAt ?? null, mins: w.windowDurationMins ?? null } : null;
}

function bucket(s = {}) {
  return { id: s.limitId ?? null, name: s.limitName ?? null, model: s.normalModelSlug ?? null,
    primary: win(s.primary), secondary: win(s.secondary), reached: s.rateLimitReachedType ?? null };
}

async function readCodex() {
  const at = Math.floor(Date.now() / 1000), command = findCommand(), auth = codexAuth();
  if (!command || !auth) return snapshot('codex', { at, status: command ? 'not-logged-in' : 'not-installed' }, 'CODEX');
  const result = await readRaw(auth, command);
  const main = result.rateLimits || (result.rateLimitsByLimitId || {}).codex || {};
  const snap = { at, status: 'ok', auth: 'chatgpt', accountKey: auth.key, plan: main.planType ?? auth.plan,
    credits: main.credits ? { balance: main.credits.balance == null ? null : Number(main.credits.balance),
      has: main.credits.hasCredits, unlimited: main.credits.unlimited } : null,
    resetCredits: result.rateLimitResetCredits ? result.rateLimitResetCredits.availableCount : null,
    main: bucket(main), buckets: Object.values(result.rateLimitsByLimitId || {}).map(bucket) };
  snap.cost = require('./codex-cost').compute(snap);
  return snapshot('codex', snap, 'CODEX');
}

module.exports = { readCodex, readRaw, findCommand, removeRuntime };

if (require.main === module) {
  const job = process.argv.includes('--raw') ? readRaw() : readCodex();
  job.then((s) => console.log(JSON.stringify(s, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
