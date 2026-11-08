---
name: "windows-readonly-dirs-rmtree"
description: "删除报拒绝访问时区分只读、占用和权限，并检查部分删除结果"
metadata:
  type: reference
---

# Windows 删除失败与只读属性

`shutil.rmtree` 或 `os.rmdir` 报 `PermissionError: [WinError 5]` 时，先确认失败对象的属性、占用和访问权限。目录显示只读不等于所有拒绝访问都由只读引起。

- 已确认是只读项时，仅对该目标用 `os.chmod(path, stat.S_IWRITE)` 去掉只读后重试失败操作。
- 递归删除的异常回调按 Python 版本选 `onexc` 或 `onerror`；不要把权限不足或文件占用也当作只读错误反复重试。
- 删除中断可能已经移除部分文件。恢复工作前检查剩余目录；涉及仓库时核对 `git status`，避免把半完成状态当成完整原件。
- 重试前重新核对目标边界，不对无关目录批量清除属性。
