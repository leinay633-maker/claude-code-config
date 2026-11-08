// Cursor sessionStart hook：把这台电脑的全局规则（~/.claude/CLAUDE.md）和记忆索引（~/.claude/memory/MEMORY.md）注入会话。
// Cursor 不读用户级的 AGENTS.md，所以规则也走这里。
// stdout 要输出 JSON：{"additional_context": "..."}；读不到文件时输出空对象，不挡会话启动。
const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = path.join(os.homedir(), '.claude');
const rulesPath = path.join(claudeDir, 'CLAUDE.md');
const memoryDir = path.join(claudeDir, 'memory');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};

const sections = [];
const rules = read(rulesPath);
if (rules) sections.push(`# 全局规则（${rulesPath}）\n\n${rules}`);

const index = read(path.join(memoryDir, 'MEMORY.md'));
if (index) {
  sections.push(
    `# 长期记忆（和 Claude Code 同一份）\n` +
    `目录：${memoryDir}\n` +
    `以下是索引，每行一条。任务相关时打开对应文件读全文；记忆是写入时的快照，引用路径、端口、开关前先核实现状。\n\n` +
    index
  );
}

process.stdout.write(JSON.stringify(sections.length ? { additional_context: sections.join('\n\n---\n\n') } : {}));
