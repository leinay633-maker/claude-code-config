---
name: "cc-terminal-ui"
description: "方向键先排查修饰键，标题 hook 按标签页定位控制台并隔离状态"
metadata:
  type: reference
---

# Windows 终端输入与标签页隔离

## 输入问题按层定位

远程会话中的方向键异常，先检查终端实际收到的是方向键还是 Shift 加方向键。可在连接端临时切换 NumLock 验证；只有确认输入正常后，再排查应用按键绑定。

文本粘贴、图片粘贴和终端快捷键可能走不同处理链。按安装版本的帮助与实际绑定确认，不用另一平台的默认键位推断，也不因按键问题直接切换渲染器。

## 标签页标题与 hook

- Windows Terminal 的 `MainWindowTitle` 可能反映当前聚焦标签页，不能单独证明目标标签页的标题是否写入成功。
- 标题应写到本会话对应的控制台。使用 `AttachConsole` 时，不能仅凭返回成功判断附着正确；还要核对进程归属和控制台进程列表。
- 控制台标题可用 `SetConsoleTitle` 设置、`GetConsoleTitleW` 核对。不要通过遍历无关祖先进程试写其他控制台。
- 需要缓存时按 `WT_SESSION` 隔离，缺少该值再用本会话的 shell PID；不要让多个标签页共用一个状态文件。
- `FreeConsole` 会影响当前进程标准输入输出。依赖这些流的读写和子进程启动应先完成，不能在同一脚本里忽略先后关系。
- 会被应用读取为上下文的 hook 标准输出保持为空；诊断和子进程输出另行重定向。
- Windows PowerShell 5.1 不支持 PowerShell 7 的 Unicode 转义写法；需要补充平面字符时可用 `[Char]::ConvertFromUtf32()`。

相关：[[powershell_pitfalls]]。
