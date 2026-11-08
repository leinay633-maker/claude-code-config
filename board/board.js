'use strict';

(async function () {
  const ID = /^[a-z0-9-]+$/;
  const LEN = { five: 5 * 3600, week: 7 * 86400 };
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const now = () => Date.now() / 1000;
  const cleanAccounts = (list) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter((a) => {
      if (!a || typeof a.id !== 'string' || !ID.test(a.id) || seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  };
  function load(file) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `${file}?t=${Date.now()}`;
      script.onload = () => { script.remove(); resolve(true); };
      script.onerror = () => { script.remove(); resolve(false); };
      document.head.appendChild(script);
    });
  }

  const loadedWarmups = new Set();
  async function loadWarmups(list) {
    await Promise.all([...new Set([...list.map((a) => a.id), 'codex'])].map(async (id) => {
      if (!loadedWarmups.has(id) && await load(`warmup-${id}.js`)) loadedWarmups.add(id);
    }));
  }
  await load('accounts.js');
  let accounts = cleanAccounts(window.ACCOUNTS);
  await Promise.all([...accounts.map((a) => load(`acct-${a.id}.js`)), ...['cost.js', 'speed.js', 'codex.js'].map(load), loadWarmups(accounts)]);
  let accts = window.ACCTS || {}, cost = window.COST, speed = window.SPEED, codex = window.CODEX;
  const live = { accounts: false, cost: false, speed: false, codex: false };
  const errors = {};
  const isFile = location.protocol === 'file:';
  let pending = !isFile;
  const selectedPort = new URLSearchParams(location.search).get('port');
  const port = selectedPort && /^\d+$/.test(selectedPort) && Number(selectedPort) > 0 && Number(selectedPort) <= 65535
    ? Number(selectedPort) : 8411;
  const base = location.origin;
  if (isFile) {
    const url = `http://127.0.0.1:${port}/`;
    document.getElementById('offline-hint').hidden = false;
    const link = document.getElementById('live-url');
    link.href = url;
    link.textContent = url;
  }

  function date(sec) {
    if (!finite(sec) || sec <= 0) return '—';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sec * 1000));
  }
  function ago(sec) {
    const m = Math.max(0, Math.round((now() - sec) / 60));
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
  }
  function effective(w) {
    if (!w || !finite(w.pct)) return null;
    const reset = finite(w.reset) && w.reset > 0 ? w.reset : null;
    const done = !!reset && reset <= now();
    return { pct: done ? 0 : Math.max(0, Math.round(w.pct)), reset, done };
  }
  const color = (pct) => pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--yellow)' : 'var(--green)';
  function start(w, name) {
    if (!w || !finite(w.reset) || !w.reset) return null;
    if (w.reset > now()) return w.reset - LEN[name];
    return now() - w.reset <= LEN[name] ? w.reset : null;
  }
  function usdOf(id, name) {
    const a = cost && cost.accts && cost.accts[id], r = accts[id];
    if (!a || !finite(a[name]) || !r || !cost.wins || !cost.wins[id] ||
      cost.wins[id][name] !== start(r[name], name)) return '';
    const est = a[name + 'Est'] || 0;
    const unknown = cost.unpriced && cost.unpriced.length ? `；未计价模型：${cost.unpriced.join('、')}` : '';
    return `<span class="usd" title="${esc('按 API 价折算' + unknown)}">$${a[name].toFixed(2)}` +
      `${est > a[name] * 0.05 ? ' 含补算' : ''}${live.cost ? '' : ' 快照'}</span>`;
  }
  function quota(label, w, amount = '') {
    if (!w) return `<div class="win"><div class="row"><span class="label">${label}</span><span class="pct">—</span></div></div>`;
    const reset = w.done ? '已重置' : w.reset ? `重置于 ${date(w.reset)}` : '暂无重置时间';
    return `<div class="win"><div class="row"><span class="label">${label}</span>` +
      `<span class="pct" style="color:${color(w.pct)}">${w.pct}%</span></div>` +
      `<div class="bar"><i style="width:${Math.min(100, w.pct)}%;background:${color(w.pct)}"></i></div>` +
      `<div class="reset${w.done ? ' done' : ''}"><span>${reset}</span>${amount}</div></div>`;
  }

  function subEnd(sub, at) {
    if (!finite(sub) || sub <= 0 || !finite(at) || at < sub) return Infinity;
    const s = new Date(sub * 1000);
    // 每个月都从原始开通日推算，小月取月末，避免月底续费日期逐月漂移。
    for (let n = 1; n < 2400; n++) {
      const y = s.getUTCFullYear(), m = s.getUTCMonth() + n;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const t = Date.UTC(y, m, Math.min(s.getUTCDate(), last), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()) / 1000;
      if (t > at) return t;
    }
    return Infinity;
  }
  function warmupOf(id) {
    const w = (window.WARMUP || {})[id];
    return w && finite(w.at) && w.at > 0 ? w : null;
  }
  function aliveAt(id) {
    const w = warmupOf(id);
    if (!w) return 0;
    return finite(w.alive) && w.alive > 0 ? w.alive : ['ok', 'limit'].includes(w.status) ? w.at : 0;
  }
  function lapsedAt(id) {
    const w = warmupOf(id);
    return w && w.status === 'error' && /can't use your Claude subscription|payment is past due/i.test(w.msg) ? w.at : 0;
  }
  function loginOut(id) {
    const w = warmupOf(id);
    return w && w.status === 'error' && !lapsedAt(id) &&
      /time limit and cannot be renewed|Failed to authenticate|claude auth login/i.test(w.msg) ? w.at : 0;
  }
  function loginSoon(id) {
    const w = warmupOf(id);
    if (!w || w.status !== 'ok') return '';
    const msg = String(w.msg || '');
    if (/can end at any time|may have ended/i.test(msg)) return '登录随时可能失效';
    const m = msg.match(/ends between (\d{4})-(\d{2})-(\d{2})/i);
    if (m && new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime() / 1000 - now() < 2 * 86400) {
      return `登录 ${m[2]}-${m[3]} 起可能失效`;
    }
    return '';
  }
  function warmLine(id) {
    const w = warmupOf(id);
    if (!w) return '';
    const [label, color] = w.status === 'ok' ? ['成功', 'var(--green)']
      : w.status === 'limit' ? [/weekly/i.test(w.msg) ? '本周额度已满' : '额度已满', 'var(--red)']
      : w.status === 'timeout' ? ['超时', 'var(--red)']
      : w.status === 'skip' ? ['跳过', 'var(--sub)']
      : lapsedAt(id) ? ['扣款失败', 'var(--red)']
      : loginOut(id) ? ['登录到期', 'var(--red)'] : ['失败', 'var(--red)'];
    const soon = loginSoon(id);
    return `<span class="warmup" title="${esc(w.msg || '')}">预热 ${date(w.at)}（${ago(w.at)}）` +
      `<span style="color:${color};white-space:nowrap">${label}</span>` +
      `${soon ? ` <span style="color:var(--yellow);white-space:nowrap">· ${esc(soon)}</span>` : ''}</span>`;
  }
  function subscription(r) {
    if (r.end === Infinity) return '';
    const gone = r.end <= now(), soon = !gone && r.end - now() < 3 * 86400;
    const tip = r.lapsed ? '最近预热提示订阅付款失败，恢复后由新预热结果更新'
      : r.endBy ? `按 ${date(r.endBy)} 预热证明订阅可用的时间推算月度续费日`
      : '按开通日和最近额度快照推算月度续费日';
    return `<div class="row sub${gone ? ' gone' : soon ? ' soon' : ''}" title="${esc(tip)}">` +
      '<span class="label">订阅到期（推算）</span>' +
      `<span class="when">${r.lapsed ? '扣款失败 · ' : gone ? '已过推算日期 · ' : ''}${date(r.end)}</span></div>`;
  }
  const MODEL = {
    'claude-opus-5-5': 'Opus 5.5', 'claude-opus-5': 'Opus 5',
    'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-sonnet-5': 'Sonnet 5',
    'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-mythos-5-1': 'Mythos 5.1',
    'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6-astra': 'GPT-6 Astra', 'gpt-6-luna': 'GPT-6 Luna',
  };
  const modelName = (m) => MODEL[String(m).replace(/\[.*\]$/, '')] || String(m);
  function speedRow(id, isCodex = false) {
    const fresh = speed && finite(speed.at) && now() - speed.at < 3600;
    const v = fresh && (isCodex ? speed.codex : speed.accts && speed.accts[id]);
    const suffix = live.speed ? '' : ' 快照';
    let body;
    if (!v || !Array.isArray(v.models)) {
      const text = live.speed ? '近 1 小时没用' : fresh ? '近 1 小时没用 · 快照'
        : errors.speed || (isFile ? '尚无速度快照' : '正在读取…');
      body = `<div class="row"><span class="label">速度</span><span class="idle">${esc(text)}</span></div>`;
    } else if (!v.models.length) {
      body = `<div class="row" title="${Number(v.short) || 0} 次请求输出均不足 200 token"><span class="label">速度</span>` +
        `<span class="idle">近 1 小时没有长回复${suffix}</span></div>`;
    } else {
      const m = v.models[0];
      const tip = v.models.map((x) => `${modelName(x.model)}：${x.n} 次，${Math.round(x.out / x.dur)} token/秒`).join('\n');
      body = `<div class="row" title="${esc(tip)}"><span class="label">速度</span>` +
        `<span class="pct">${Math.round(m.out / m.dur)} token/秒</span></div>` +
        `<div class="reset"><span>${esc(modelName(m.model))}</span><span>近 1 小时 ${m.n} 次${suffix}</span></div>`;
    }
    return `<div class="win spd">${body}</div>`;
  }

  function renderClaude() {
    const rows = accounts.map(({ id }) => {
      const r = accts[id] || {};
      // 失败或超时仍可沿用上次 alive；付款失败则按最近一次明确拒绝订阅的结果显示。
      const seen = Math.max(finite(r.at) ? r.at : 0, aliveAt(id)), lapsed = lapsedAt(id);
      return { id, email: r.email || '', five: effective(r.five), week: effective(r.week),
        at: r.at, end: lapsed || subEnd(r.sub, seen), lapsed,
        endBy: !lapsed && seen > (r.at || 0) ? seen : null, login: loginOut(id) };
    });
    const loginDown = (r) => r.login && (!r.at || r.at < r.login);
    const known = rows.filter((r) => r.at && (r.five || r.week));
    const blockers = (r) => [[r.five, 90], [r.week, 100]]
      .filter(([w, threshold]) => w && w.pct >= threshold).map(([w]) => w.reset || Infinity);
    const backAt = (r) => Math.max(...blockers(r));
    const dead = (r) => r.end <= now() || (blockers(r).length && backAt(r) >= r.end);
    const plan = (r) => r.week && !r.week.done && r.week.reset && r.week.reset <= r.end
      ? { at: r.week.reset, label: '本周重置', left: Math.max(0, 100 - r.week.pct) }
      : { at: r.end, label: '订阅到期（推算）', left: r.week ? Math.max(0, 100 - r.week.pct) : 100 };
    const load = (r) => Math.max(r.five ? r.five.pct : 0, r.week ? r.week.pct : 0);
    const byUse = (a, b) => plan(a).at - plan(b).at || load(a) - load(b);
    const usable = known.filter((r) => !dead(r));
    const order = known.length === rows.length ? [
      ...usable.filter((r) => !blockers(r).length && !loginDown(r)).sort(byUse),
      ...usable.filter((r) => blockers(r).length && !loginDown(r)).sort((a, b) => backAt(a) - backAt(b) || byUse(a, b)),
      ...usable.filter(loginDown).sort(byUse),
    ] : [];
    const best = order.length && !blockers(order[0]).length && !loginDown(order[0]) ? order[0] : null;
    const rank = Object.fromEntries(order.map((r, i) => [r.id, i + 1]));
    let hero;
    if (!rows.length) hero = '<span class="lead">尚未配置账号，请先运行安装脚本</span>';
    else if (known.length < rows.length) hero = `<span class="lead">还有 ${rows.length - known.length} 个账号没有额度快照，用对应账号发一条消息后刷新</span>`;
    else if (best) {
      const p = plan(best);
      hero = `<span class="lead">现在用</span><span class="big">${esc(best.id.toUpperCase())}</span>` +
        `<span class="why">${p.at === Infinity ? '额度可用' : `${p.label} ${date(p.at)} · 还剩 ${p.left}%`} · 5 小时 ${best.five ? best.five.pct : 0}%</span>`;
    } else if (order.length && loginDown(order[0])) hero = `<span class="lead">可用账号需要重新登录</span>` +
      `<span class="big">${esc(order[0].id.toUpperCase())}</span><span class="why">请用该账号的入口重新登录</span>`;
    else if (order.length) hero = `<span class="lead">最早恢复的是</span><span class="big">${esc(order[0].id.toUpperCase())}</span>` +
      `<span class="why">${date(backAt(order[0]))}</span>`;
    else hero = '<span class="lead">暂无可推荐账号，请更新额度快照</span>';
    document.getElementById('hero').innerHTML = hero;
    document.getElementById('queue').innerHTML = order.length > 1 ? '<span class="lead">之后</span>' + order.slice(1).map((r) => {
      const p = plan(r), blocked = blockers(r).length || loginDown(r);
      const note = loginDown(r) ? '登录到期，先重新登录' : blocked ? `${date(backAt(r))} 恢复`
        : p.at === Infinity ? '额度可用' : `${date(p.at)} · 剩 ${p.left}%`;
      return `<span class="q${blocked ? ' stuck' : ''}"><b>${esc(r.id.toUpperCase())}</b><small>${esc(note)}</small></span>`;
    }).join('<span class="arrow">→</span>') : '';
    document.getElementById('grid').innerHTML = rows.map((r) => {
      const chosen = best && r.id === best.id, gone = r.at && dead(r);
      const tag = chosen ? '<span class="tag">现在用</span>' : rank[r.id] ? `<span class="tag dim">第 ${rank[r.id]} 个</span>`
        : gone ? '<span class="tag dim">需更新快照</span>' : '';
      const foot = r.at ? `额度快照 ${date(r.at)}（${ago(r.at)}）` : '还没有快照，用对应账号发一条消息后刷新';
      const warm = warmLine(r.id);
      return `<div class="card${chosen ? ' best' : ''}${gone ? ' gone' : ''}" data-account="${esc(r.id)}">` +
        `<div class="top"><span class="letter">${esc(r.id.toUpperCase())}</span><span class="email" title="${esc(r.email)}">${esc(r.email)}</span>${tag}</div>` +
        quota('5 小时', r.five, usdOf(r.id, 'five')) + quota('本周', r.week, usdOf(r.id, 'week')) +
        subscription(r) + speedRow(r.id) + `<div class="foot">${foot}${warm ? '<br>' + warm : ''}</div></div>`;
    }).join('');
  }

  const PLAN = { pro: 'ChatGPT Pro', plus: 'ChatGPT Plus', prolite: 'ChatGPT Pro Lite', promax: 'ChatGPT Pro Max' };
  function codexUsd(name, window) {
    const c = codex && codex.cost;
    if (!c || !finite(c[name]) || !c.wins || c.wins[name] !== start(window, name)) return '';
    const tip = '按 OpenAI API 价折算' + (c[name + 'Ledger'] ? `；其中预热补记 $${c[name + 'Ledger'].toFixed(6)}` : '') +
      (c.tierEstimated ? '；未记录档位的请求按当前配置估算' : '') +
      (c.unpriced && c.unpriced.length ? `；未计价模型：${c.unpriced.join('、')}` : '');
    return `<span class="usd" title="${esc(tip)}">$${c[name].toFixed(2)}${live.codex ? '' : ' 快照'}</span>`;
  }
  function renderCodex() {
    const ok = codex && codex.status === 'ok' && codex.auth === 'chatgpt' && codex.main;
    const warm = warmLine('codex');
    let body;
    if (ok) {
      const pick = (mins) => [codex.main.primary, codex.main.secondary].find((w) => w && w.mins === mins);
      body = quota('5 小时', effective(pick(300)), codexUsd('five', pick(300))) +
        quota('本周', effective(pick(10080)), codexUsd('week', pick(10080))) + speedRow('', true) +
        `<div class="foot">${live.codex ? '实时读取' : '快照'} ${date(codex.at)}（${ago(codex.at)}）` +
        `${errors.codex ? `<br>${esc(errors.codex)}` : ''}${warm ? '<br>' + warm : ''}</div>`;
    } else {
      const message = codex && codex.status === 'not-installed' ? '未安装 Codex' : codex && codex.status === 'not-logged-in'
        ? '未使用 ChatGPT 订阅登录 Codex' : errors.codex || (isFile ? '尚无 Codex 快照' : '正在读取…');
      body = `<div class="empty">${esc(message)}</div>${warm ? `<div class="foot">${warm}</div>` : ''}`;
    }
    document.getElementById('others').innerHTML = `<div class="card" id="codex"><div class="top"><span class="letter word">Codex</span>` +
      `<span class="email">${ok ? esc(PLAN[codex.plan] || codex.plan || '') : ''}</span></div>${body}</div>`;
  }
  function render() {
    document.getElementById('now').textContent = `本地时间 ${date(now())}`;
    document.getElementById('status').textContent = isFile ? '离线模式，仅显示本地快照'
      : pending ? '本地快照已读取，正在补充实时数据…'
      : !Object.values(live).some(Boolean) ? '服务未启动，显示本地快照'
      : Object.keys(errors).length ? '本地快照已读取，部分实时数据暂不可用' : '实时数据已更新';
    renderClaude();
    renderCodex();
  }
  async function request(route) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(base + route, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '实时数据暂不可用');
      return data;
    } finally { clearTimeout(timer); }
  }
  render();
  if (!isFile) {
    await Promise.all(['accounts', 'cost', 'speed', 'codex'].map(async (kind) => {
      try {
        const data = await request('/' + kind);
        if (kind === 'accounts') {
          accounts = cleanAccounts(data.accounts); accts = data.accts || {};
          await loadWarmups(accounts);
        }
        if (kind === 'cost') cost = data;
        if (kind === 'speed') speed = data;
        if (kind === 'codex') codex = data;
        live[kind] = true;
      } catch (error) {
        errors[kind] = error.name === 'TypeError' ? '服务未启动' : error.name === 'AbortError' ? '实时读取超时' : error.message;
      }
      render();
    }));
    pending = false;
    render();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') location.reload(); });
  setInterval(render, 60000);
})();
