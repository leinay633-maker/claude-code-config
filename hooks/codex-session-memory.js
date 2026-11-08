// Codex SessionStart hook：把这台电脑的记忆索引（~/.claude/memory/MEMORY.md，和 Claude Code 同一份）注入会话。
// stdout 的纯文本就是注入内容；没有索引时静默退出，不挡会话启动。
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), '.claude', 'memory');
let index = '';
try {
  index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim();
} catch {}
if (!index) process.exit(0);

process.stdout.write(
  `# 长期记忆（和 Claude Code 同一份）\n` +
  `目录：${dir}\n` +
  `以下是索引，每行一条。任务相关时打开对应文件读全文；记忆是写入时的快照，引用路径、端口、开关前先核实现状。\n\n` +
  index
);
