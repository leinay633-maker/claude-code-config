'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = os.homedir();
const DIR = path.resolve(process.env.CLAUDE_BOARD_DIR || path.join(HOME, '.claude', 'board'));
const PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_HOME = path.join(HOME, '.codex');
const ID = /^[a-z0-9-]+$/;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function accounts() {
  const file = path.join(DIR, 'accounts.json');
  if (!fs.existsSync(file)) return [];
  const data = readJson(file);
  if (!data || !Array.isArray(data.accounts)) throw new Error('accounts.json 需要 accounts 数组');
  const ids = new Set();
  return data.accounts.map((a) => {
    if (!a || typeof a.id !== 'string' || !ID.test(a.id) || ids.has(a.id)) {
      throw new Error('账号 id 必须唯一，且只能包含小写字母、数字和连字符');
    }
    if (a.configDir !== null && (typeof a.configDir !== 'string' || !a.configDir ||
      /^[. ]+$/.test(a.configDir) || /[<>:"/\\|?*\x00-\x1f]/.test(a.configDir) || /[. ]$/.test(a.configDir))) {
      throw new Error('configDir 需要为 null 或家目录下的单个目录名');
    }
    ids.add(a.id);
    return { id: a.id, configDir: a.configDir };
  });
}

function configPath(account) {
  return path.join(HOME, account.configDir === null ? '.claude' : account.configDir);
}

function readAccount(account) {
  const snap = readJson(path.join(DIR, `acct-${account.id}.json`), {});
  const authFile = account.configDir === null
    ? path.join(HOME, '.claude.json') : path.join(configPath(account), '.claude.json');
  const auth = readJson(authFile, {}).oauthAccount || {};
  const sub = Date.parse(auth.subscriptionCreatedAt) / 1000;
  return {
    acct: account.id,
    email: auth.emailAddress || snap.email || '',
    sub: Number.isFinite(sub) ? sub : snap.sub || null,
    five: snap.five || null,
    week: snap.week || null,
    at: Number.isFinite(snap.at) ? snap.at : null,
  };
}

function atomicWrite(file, text) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function snapshot(name, value, global) {
  const body = JSON.stringify(value);
  atomicWrite(path.join(DIR, `${name}.json`), body);
  atomicWrite(path.join(DIR, `${name}.js`), `window.${global}=${body};\n`);
  return value;
}

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

function codexAuth() {
  const data = readJson(path.join(CODEX_HOME, 'auth.json'), {});
  const tokens = data.tokens || {};
  const mode = data.auth_mode || (!data.OPENAI_API_KEY && tokens.access_token ? 'chatgpt' : null);
  if (mode !== 'chatgpt' || !tokens.access_token) return null;
  const claims = jwtClaims(tokens.id_token || tokens.access_token);
  const details = claims['https://api.openai.com/auth'] || {};
  const accountId = tokens.account_id || details.chatgpt_account_id;
  if (!accountId) return null;
  return {
    accessToken: tokens.access_token,
    accountId,
    plan: details.chatgpt_plan_type || null,
    key: crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 24),
  };
}

module.exports = { HOME, DIR, PROJECTS, CODEX_HOME, ID, accounts, configPath, readAccount, readJson,
  atomicWrite, snapshot, codexAuth };
