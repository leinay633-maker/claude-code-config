---
name: "skill-validate-gbk-crash"
description: "校验脚本按本地代码页解码失败时显式启用 UTF-8，隔离模式用解释器参数"
metadata:
  type: reference
---

# 中文文件校验与 Python UTF-8 模式

Windows 上，未指定编码的文本读取可能使用本地代码页。UTF-8 中文文件出现 `UnicodeDecodeError: 'gbk' codec can't decode` 时，先核对文件编码和脚本的读取方式，不要直接改坏内容正确的文件。

- 可修改的脚本用 `Path.read_text(encoding='utf-8')`。
- 运行现有校验器时，用 `python -X utf8 <校验脚本> <技能目录>`。
- `python -I` 会忽略 `PYTHON*` 环境变量；需要隔离模式时用 `python -I -X utf8 <脚本>`，不要仅依赖 `PYTHONUTF8=1`。
- 终端乱码和磁盘文件损坏分开检查。校验规则以当前校验器为准，不沿用旧版字段清单和长度限制。
