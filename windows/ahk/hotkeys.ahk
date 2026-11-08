#Requires AutoHotkey v2.0
#SingleInstance Force

; ── Caps Lock：短按切换中英文，长按开关大写锁定（对齐 Mac）──
*CapsLock::
{
    if KeyWait("CapsLock", "T0.3") {
        Send("{Shift}")
        return
    }
    SetCapsLockState(GetKeyState("CapsLock", "T") ? "Off" : "On")
    KeyWait("CapsLock")
}

; 鼠标侧键切换虚拟桌面
; XButton1 (后退键) = 上一个桌面
; XButton2 (前进键) = 下一个桌面

XButton1:: Send("^#{Left}")   ; Win+Ctrl+←
XButton2:: Send("^#{Right}")  ; Win+Ctrl+→

; ── Win+Alt+←/→ 精确半屏 ──
; 系统 Snap 占了这组键，会把窗口丢进三分区布局给出 1/3。
; AHK 用键盘钩子，先于系统的 RegisterHotKey 拿到按键，能压过去。
; 单按 = 半屏；同时按住另一根垂直/水平方向键 = 四分之一屏（如 Win+Alt+↓+→ 右下角）。
; 组合键不用 AHK 的 `&` 语法（它不支持再带修饰键），直接在处理函数里查另一根键的状态。
#!Left::Snap("L")
#!Right::Snap("R")
#!Up::Snap("U")
#!Down::Snap("D")

Snap(key) {
    static Opposite := Map("L", ["Up", "Down"], "R", ["Up", "Down"]
                         , "U", ["Left", "Right"], "D", ["Left", "Right"])

    hw := WinExist("A")
    if !hw
        return

    ; 先按主键定半屏，再看垂直方向上有没有同时按住键，有就收成四分之一
    horiz := "", vert := ""
    if (key = "L" || key = "R")
        horiz := key
    else
        vert := key

    for k in Opposite[key] {
        if !GetKeyState(k, "P")
            continue
        if (k = "Left" || k = "Right")
            horiz := (k = "Left") ? "L" : "R"
        else
            vert := (k = "Up") ? "U" : "D"
        break
    }

    MonitorGetWorkArea(MonitorOf(hw), &l, &t, &r, &b)
    w := (r - l), h := (b - t)
    if horiz {
        w //= 2
        if (horiz = "R")
            l += w
    }
    if vert {
        h //= 2
        if (vert = "D")
            t += h
    }

    if WinGetMinMax(hw)          ; 最大化/最小化状态下 WinMove 无效
        WinRestore(hw)

    ; 窗口矩形左右各含约 9px 透明拖拽边，直接按目标尺寸摆会留下 18px 黑缝。
    ; 用 DWM 可见边框反推边距，把窗口矩形外扩，让看得见的边框贴齐目标区域。
    GetFrameInset(hw, &il, &ir, &it, &ib)
    WinMove(l - il, t - it, w + il + ir, h + it + ib, hw)
}

; 窗口矩形与 DWM 可见边框之间的差值（左/右/上/下）
GetFrameInset(hw, &il, &ir, &it, &ib) {
    il := ir := it := ib := 0
    rc := Buffer(16, 0)
    ; DWMWA_EXTENDED_FRAME_BOUNDS = 9
    if DllCall("dwmapi\DwmGetWindowAttribute", "ptr", hw, "uint", 9, "ptr", rc, "uint", 16, "int")
        return                                  ; 取不到就按原样摆，不比现在更差
    WinGetPos(&wx, &wy, &ww, &wh, hw)
    il := NumGet(rc, 0, "int") - wx
    it := NumGet(rc, 4, "int") - wy
    ir := (wx + ww) - NumGet(rc, 8, "int")
    ib := (wy + wh) - NumGet(rc, 12, "int")
}

; 按窗口中心点判断它在哪块显示器上
MonitorOf(hw) {
    WinGetPos(&wx, &wy, &ww, &wh, hw)
    cx := wx + ww // 2, cy := wy + wh // 2
    loop MonitorGetCount() {
        MonitorGet(A_Index, &ml, &mt, &mr, &mb)
        if (cx >= ml && cx < mr && cy >= mt && cy < mb)
            return A_Index
    }
    return MonitorGetPrimary()
}

; ── Chrome / Edge：Alt+数字 切标签（对齐 Mac 的 Cmd+数字）──
#HotIf WinActive("ahk_exe chrome.exe") || WinActive("ahk_exe msedge.exe")
!1::Send("^1")
!2::Send("^2")
!3::Send("^3")
!4::Send("^4")
!5::Send("^5")
!6::Send("^6")
!7::Send("^7")
!8::Send("^8")
!9::Send("^9")   ; 最后一个标签，跟 Mac Cmd+9 一致
!t::Send("{Alt up}^t")    ; 新标签，先松 Alt 免得触发菜单栏
!+t::Send("{Alt up}^+t")  ; 恢复刚关掉的标签
!w::Send("{Alt up}^w")    ; 关闭当前标签
#HotIf

; ── Windows Terminal：Ctrl+V 贴文字和截图都不显示 Claude Code 的 Pasting ──
; 有文字就原样发 Ctrl+V，WT 的 settings.json 里 Ctrl+V 绑的是 WT 自己的粘贴。
; 不转发 Ctrl+Shift+V：剪贴板管理工具常把它占成全局热键，会弹窗。
; 剪贴板只有图片时 WT 会吞键，CC 在原生 Windows 上读图要起 PowerShell，
; 所以先把图存成 PNG、把路径当文字贴进去，CC 按拖入图片文件处理成 [Image #N]。
#HotIf WinActive("ahk_exe WindowsTerminal.exe")
$^v::TerminalPaste()
#HotIf

TerminalPaste() {
    png := DllCall("RegisterClipboardFormat", "str", "PNG", "uint")
    ; 13 = CF_UNICODETEXT，2 = CF_BITMAP（只有 DIB 时系统也会合成）
    hasImage := DllCall("IsClipboardFormatAvailable", "uint", 2) || DllCall("IsClipboardFormatAvailable", "uint", png)
    if DllCall("IsClipboardFormatAvailable", "uint", 13) || !hasImage {
        Send("^v")
        return
    }
    path := SaveClipboardImage()
    if !path {
        Send("^v")
        return
    }
    saved := ClipboardAll()
    if !SetClipboardTextPrivate(path) {
        Send("^v")
        return
    }
    Send("^v")
    Sleep(300)                  ; WT 异步读剪贴板，还原太快会读到图片
    A_Clipboard := saved
}

; 写纯文本到剪贴板，并带上让剪贴板历史（Win+V 和剪贴板管理工具）跳过的标记，临时路径不进历史
SetClipboardTextPrivate(text) {
    loop 10 {
        if DllCall("OpenClipboard", "ptr", A_ScriptHwnd)
            break
        if A_Index = 10
            return false
        Sleep(20)
    }
    DllCall("EmptyClipboard")
    h := DllCall("GlobalAlloc", "uint", 0x2, "uptr", (StrLen(text) + 1) * 2, "ptr")    ; GMEM_MOVEABLE
    StrPut(text, DllCall("GlobalLock", "ptr", h, "ptr"), "UTF-16")
    DllCall("GlobalUnlock", "ptr", h)
    DllCall("SetClipboardData", "uint", 13, "ptr", h)
    for name in ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory"] {
        z := DllCall("GlobalAlloc", "uint", 0x2, "uptr", 4, "ptr")
        NumPut("uint", 0, DllCall("GlobalLock", "ptr", z, "ptr"))
        DllCall("GlobalUnlock", "ptr", z)
        DllCall("SetClipboardData", "uint", DllCall("RegisterClipboardFormat", "str", name, "uint"), "ptr", z)
    }
    DllCall("CloseClipboard")
    return true
}

; 剪贴板图片存到 %TEMP%\cc-paste，返回路径；有 PNG 格式就原样写出，没有再用 GDI+ 把位图转 PNG
SaveClipboardImage() {
    buf := Buffer(1040)         ; A_Temp 可能是 8.3 短路径，展开成长路径再交给 CC
    n := DllCall("GetLongPathNameW", "str", A_Temp, "ptr", buf, "uint", 520)
    dir := (n && n < 520 ? StrGet(buf) : A_Temp) "\cc-paste"
    DirCreate(dir)
    loop files dir "\*.png"     ; 顺手清掉一天前的
        if DateDiff(A_Now, A_LoopFileTimeModified, "Hours") >= 24
            try FileDelete(A_LoopFileFullPath)
    path := dir "\" A_Now A_MSec ".png"

    loop 10 {                   ; 别的程序可能正占着剪贴板
        if DllCall("OpenClipboard", "ptr", A_ScriptHwnd)
            break
        if A_Index = 10
            return ""
        Sleep(20)
    }
    ok := false
    try {
        png := DllCall("RegisterClipboardFormat", "str", "PNG", "uint")
        if (h := DllCall("GetClipboardData", "uint", png, "ptr")) && (p := DllCall("GlobalLock", "ptr", h, "ptr")) {
            f := FileOpen(path, "w", "CP0")    ; CP0 不写 BOM
            f.RawWrite(p, PngLength(p, DllCall("GlobalSize", "ptr", h, "uptr")))
            f.Close()
            DllCall("GlobalUnlock", "ptr", h)
            ok := true
        } else if h := DllCall("GetClipboardData", "uint", 2, "ptr") {
            ok := SaveHBitmapAsPng(h, path)
        }
    }
    DllCall("CloseClipboard")
    return ok ? path : ""
}

; GlobalSize 可能按分配粒度多出几字节：从签名后逐块走到 IEND，返回真实长度；结构不对就原样返回
PngLength(p, size) {
    off := 8
    while off + 12 <= size {
        len := DllCall("ws2_32\ntohl", "uint", NumGet(p, off, "uint"), "uint")
        type := StrGet(p + off + 4, 4, "CP0")
        off += 12 + len
        if type == "IEND"
            return Min(off, size)
    }
    return size
}

SaveHBitmapAsPng(hbm, path) {
    static token := 0
    if !token {
        DllCall("LoadLibrary", "str", "gdiplus")
        si := Buffer(24, 0)     ; GdiplusStartupInput，x64 下 24 字节
        NumPut("uint", 1, si)
        DllCall("gdiplus\GdiplusStartup", "ptr*", &token, "ptr", si, "ptr", 0)
    }
    bmp := 0
    if DllCall("gdiplus\GdipCreateBitmapFromHBITMAP", "ptr", hbm, "ptr", 0, "ptr*", &bmp)
        return false
    clsid := Buffer(16)         ; PNG 编码器
    DllCall("ole32\CLSIDFromString", "str", "{557CF406-1A04-11D3-9A73-0000F81EF32E}", "ptr", clsid)
    ok := !DllCall("gdiplus\GdipSaveImageToFile", "ptr", bmp, "wstr", path, "ptr", clsid, "ptr", 0)
    DllCall("gdiplus\GdipDisposeImage", "ptr", bmp)
    return ok
}
