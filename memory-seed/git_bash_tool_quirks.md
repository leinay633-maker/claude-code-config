---
name: "git-bash-tool-quirks"
description: "跨工具传参时核对转义，检查 CRLF 时按原始字节读取"
metadata:
  type: reference
---

# Git Bash 转义、换行与启动排查

## 转义与文本写入

命令经过工具、Bash 和目标解释器多层解析时，反斜杠、美元符号和反引号可能提前被处理。不要把某次工具行为当作所有 Bash 环境的固定规则；先用无副作用的短样例确认收到的字节。

- 含 Windows 路径、正则或 Markdown 反引号的长文本，优先用文件编辑工具写入，再执行文件。
- Bash 双引号中的反引号和 `$()` 会触发命令替换。不要把待保存的文本直接拼进这类命令。
- 引号包住的 heredoc 只能约束 shell 自身的展开，不能保证上游工具没有先改写内容。

## CRLF 文件

- Windows 版文本工具可能以文本模式读文件。检查 CR 时用 `grep -U`、`tr -cd '\r' < file.txt | wc -c` 或 `git ls-files --eol`，不要只凭普通匹配结果下结论。
- 在支持该参数的 Git Bash 环境中，用 `sed -b -i` 保留原始换行；编辑前后核对换行和差异。
- Python 需要保留 CRLF 时，读取和写入都显式设 `newline=''`；只在写入时设置不能挽回读取时已做的转换。
- 跨平台打包前检查 `.gitattributes` 和实际产物，不把本机换行设置当成所有机器的配置。

## 所有命令都在启动阶段失败

若最小命令也报 `expor: command not found` 等相同错误，先看报错指向的会话环境脚本与启动 hook。检查是否存在截断或重复追加；若修复后仍使用旧缓存，再重开会话验证，不把它直接归因于业务脚本。

相关：[[powershell_pitfalls]]。
