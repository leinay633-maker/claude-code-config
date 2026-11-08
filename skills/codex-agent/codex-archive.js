// 用官方 codex app-server 的 thread/archive 归档一个会话：记录移到 ~/.codex/archived_sessions，Codex 应用里不再列出。
// run-codex.ps1 跑完后调用。用法：node codex-archive.js <会话ID>；成功退出码 0，失败 1 并在 stderr 说原因。
'use strict';
const { spawn } = require('child_process');

const id = process.argv[2];
if (!id) { console.error('缺会话ID'); process.exit(1); }

// cmd 找命令会先查当前目录，固定在家目录起 app-server
const child = spawn('codex app-server', { shell: true, cwd: require('os').homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
let done = false;
function finish(code, msg) {
  if (done) return;
  done = true;
  if (msg) console.error(msg);
  try { child.stdin.end(); } catch {}
  // shell: true 时 child 是 cmd.exe，杀整棵树才能带走 codex 进程
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('exit', () => process.exit(code));
  else { child.kill(); process.exit(code); }
}
setTimeout(() => finish(1, 'app-server 30 秒没响应'), 30000);

let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      if (m.error) return finish(1, 'initialize 失败：' + JSON.stringify(m.error));
      send({ method: 'initialized' });
      send({ id: 2, method: 'thread/archive', params: { threadId: id } });
    } else if (m.id === 2) {
      if (m.error) return finish(1, 'thread/archive 失败：' + JSON.stringify(m.error));
      finish(0);
    }
  }
});
child.on('error', (e) => finish(1, e.message));
// app-server 先关了输入管道时写入会异步报 EPIPE，不接住就是未处理异常
child.stdin.on('error', (e) => finish(1, 'app-server 输入管道出错：' + e.message));
child.on('exit', (code) => finish(1, `app-server 提前退出（${code}）`));
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-agent', title: 'codex-agent', version: '1.0' } } });
