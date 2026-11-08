---
name: "feedback_repeat_read_unchanged_files"
description: "工具明确返回文件未变时复用已有内容，并如实交代读取状态"
metadata:
  type: feedback
---

# 文件未变时说明复用依据

若读取工具明确返回 `file unchanged since your last Read` 等状态，且已有可用的读取内容，就说明本次沿用已有内容，不声称重新获取了全文。

**Why:** 文件没有变化时重复读取不能增加证据；把缓存状态说成新读取会误导后续判断。

**How to apply:** 记录工具实际返回的状态与复用依据。若此前内容已不在上下文，或本次判断需要完整原文，则重新获取必要部分，不仅凭“未变”推断具体内容。
