'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DIR, ID, accounts, readAccount, codexAuth } = require('./board-config');
const { readCodex } = require('./codex-snapshot');
const cost = require('./claude-cost');
const speed = require('./model-speed');
const packy = require('./packy-usage');

function createServer(port) {
  const live = {
    '/cost': { read: cost.compute, ttl: 1000 },
    '/speed': { read: speed.compute, ttl: 1000 },
    '/codex': { read: readCodex, ttl: 10000 },
    '/packy': { read: packy.compute, ttl: 60000 },
  };
  const assets = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/board.js', 'board.js'], ['/order.js', 'order.js']]);
  // 端口是 80 时浏览器的 Host 和 Origin 不带端口号
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ['127.0.0.1', 'localhost'] : [])]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return http.createServer({ requireHostHeader: false }, async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
    const json = (status, value) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    // null 也可能来自沙箱网页；本地文件页面只读磁盘快照，不访问服务。
    if (!hosts.has(req.headers.host)) return json(403, { error: '无效主机' });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return json(403, { error: '仅允许看板页面访问' });
    const site = req.headers['sec-fetch-site'];
    // 从 file:// 页面的提示链接或别的页面点开看板是跨站的顶层导航；页面本身不含数据、也不许被嵌入，放行，数据和脚本仍只认同源
    const pageNav = ['/', '/index.html'].includes(req.url.split('?')[0]) &&
      req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !pageNav) {
      return json(403, { error: '不允许跨来源访问' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      return res.end();
    }
    if (req.method !== 'GET') return json(405, { error: '只支持 GET' });
    let route;
    try { route = decodeURIComponent(req.url.split('?')[0]); }
    catch { return json(400, { error: '无效地址' }); }
    // 先检查原始路径，避免 URL 规范化把目录穿越变成白名单中的文件。
    if (!route.startsWith('/') || route.slice(1).includes('/') || /[\\\x00#]/.test(route) || route.includes('..')) {
      return json(404, { error: '未找到' });
    }
    try {
      if (route === '/accounts') {
        const list = accounts();
        return json(200, { accounts: list, accts: Object.fromEntries(list.map((a) => [a.id, readAccount(a)])), port });
      }
      const item = live[route];
      if (item) {
        if (route === '/codex') {
          const key = codexAuth()?.key || null;
          if (item.authKey !== key) { item.authKey = key; item.last = null; }
        }
        if (!item.last || Date.now() - item.last.at >= item.ttl) {
          if (!item.inflight) item.inflight = Promise.resolve().then(item.read).then((data) => {
            item.last = { at: Date.now(), data };
            return data;
          }).finally(() => { item.inflight = null; });
          return json(200, await item.inflight);
        }
        return json(200, item.last.data);
      }
      let file, type;
      if (assets.has(route)) {
        file = path.join(__dirname, assets.get(route));
        type = route.endsWith('.js') ? 'text/javascript' : 'text/html';
      } else {
        const name = route.slice(1);
        const match = name.match(/^(acct|warmup)-([a-z0-9-]+)\.js$/);
        if (name === 'accounts.js' || ['cost.js', 'speed.js', 'codex.js', 'packy.js'].includes(name) ||
          (match && ID.test(match[2]) && ((match[1] === 'warmup' && match[2] === 'codex') ||
            accounts().some((a) => a.id === match[2])))) {
          file = path.join(DIR, name);
          type = 'text/javascript';
        }
      }
      if (!file) return json(404, { error: '未找到' });
      let stat;
      try { stat = fs.lstatSync(file); } catch { return json(404, { error: '未找到' }); }
      if (!stat.isFile()) return json(404, { error: '未找到' });
      res.writeHead(200, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
      res.end(fs.readFileSync(file));
    } catch (error) {
      const message = route === '/codex' ? error.message
        : route === '/accounts' ? error.message : '本地数据暂时无法读取，请稍后刷新';
      json(route === '/codex' ? 502 : 500, { error: message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.CLAUDE_BOARD_PORT || 8411);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('CLAUDE_BOARD_PORT 需要为 1–65535 的整数');
    process.exitCode = 1;
  } else {
    const server = createServer(port);
    server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? '看板端口已被占用' : '看板服务启动失败'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`看板服务 http://127.0.0.1:${port}`));
    // 今天和近 7 天的 Packy 花费靠采样相减，没人开页面时也要采
    const sample = () => packy.compute().catch(() => {});
    sample();
    setInterval(sample, 600000);
  }
}

module.exports = { createServer };
