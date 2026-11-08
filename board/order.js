'use strict';

// 切号顺序：看板页面和状态栏共用这一份，两边排出来的顺序才一致。
// 浏览器里挂在 window.BoardOrder，Node 里 require。时间都用秒。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardOrder = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);

  function effective(w, now) {
    if (!w || !finite(w.pct)) return null;
    const reset = finite(w.reset) && w.reset > 0 ? w.reset : null;
    const done = !!reset && reset <= now;
    return { pct: done ? 0 : Math.max(0, Math.round(w.pct)), reset, done };
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

  function warmupOf(warmup, id) {
    const w = (warmup || {})[id];
    return w && finite(w.at) && w.at > 0 ? w : null;
  }
  function aliveAt(warmup, id) {
    const w = warmupOf(warmup, id);
    if (!w) return 0;
    return finite(w.alive) && w.alive > 0 ? w.alive : ['ok', 'limit'].includes(w.status) ? w.at : 0;
  }
  function lapsedAt(warmup, id) {
    const w = warmupOf(warmup, id);
    return w && w.status === 'error' && /can't use your Claude subscription|payment is past due/i.test(w.msg) ? w.at : 0;
  }
  function loginOut(warmup, id) {
    const w = warmupOf(warmup, id);
    return w && w.status === 'error' && !lapsedAt(warmup, id) &&
      /time limit and cannot be renewed|Failed to authenticate|claude auth login|Not logged in/i.test(w.msg) ? w.at : 0;
  }

  // accounts 是 [{ id }]，accts 是各号的额度快照（acct-<号>.json），warmup 是各号最近一次预热结果
  function rows(accounts, accts, warmup, now) {
    return accounts.map(({ id }) => {
      const r = (accts || {})[id] || {};
      // 失败或超时仍可沿用上次 alive；付款失败则按最近一次明确拒绝订阅的结果显示。
      const seen = Math.max(finite(r.at) ? r.at : 0, aliveAt(warmup, id)), lapsed = lapsedAt(warmup, id);
      return { id, email: r.email || '', five: effective(r.five, now), week: effective(r.week, now),
        at: r.at, end: lapsed || subEnd(r.sub, seen), lapsed,
        endBy: !lapsed && seen > (r.at || 0) ? seen : null, login: loginOut(warmup, id), alive: aliveAt(warmup, id) };
    });
  }

  // 每个号都排进顺序：额度可用的最先，本周重置或订阅到期（推算）更早的先用，同时间用量少的先用；
  // 然后是没有额度快照的号（预热成功过的在前）、额度暂满的号（按恢复时间）、要重新登录的号，最后是订阅已过期的号。
  function rank(list, now) {
    const loginDown = (r) => r.login && (!r.at || r.at < r.login);
    const isKnown = (r) => r.at && (r.five || r.week);
    const blockers = (r) => [[r.five, 90], [r.week, 100]]
      .filter(([w, threshold]) => w && w.pct >= threshold).map(([w]) => w.reset || Infinity);
    const backAt = (r) => Math.max(...blockers(r));
    const dead = (r) => r.end <= now || (blockers(r).length && backAt(r) >= r.end);
    const plan = (r) => r.week && !r.week.done && r.week.reset && r.week.reset <= r.end
      ? { at: r.week.reset, label: '本周重置', left: Math.max(0, 100 - r.week.pct) }
      : { at: r.end, label: '订阅到期（推算）', left: r.week ? Math.max(0, 100 - r.week.pct) : 100 };
    const load = (r) => Math.max(r.five ? r.five.pct : 0, r.week ? r.week.pct : 0);
    const byUse = (a, b) => plan(a).at - plan(b).at || load(a) - load(b);
    const state = (r) => dead(r) ? 'dead' : loginDown(r) ? 'login'
      : !isKnown(r) ? (r.alive ? 'maybe' : 'unknown') : blockers(r).length ? 'blocked' : 'free';
    const of = (s) => list.filter((r) => state(r) === s);
    const order = [
      ...of('free').sort(byUse), ...of('maybe'), ...of('unknown'),
      ...of('blocked').sort((a, b) => backAt(a) - backAt(b) || byUse(a, b)),
      ...of('login').sort(byUse), ...of('dead'),
    ];
    return { order, state, plan, backAt, dead, usable: (r) => ['free', 'maybe'].includes(state(r)) };
  }

  return { finite, effective, subEnd, warmupOf, aliveAt, lapsedAt, loginOut, rows, rank };
});
