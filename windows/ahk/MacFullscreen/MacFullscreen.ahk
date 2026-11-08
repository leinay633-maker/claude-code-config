#Requires AutoHotkey v2.0
#SingleInstance Force
; MacFullscreen — 点最大化按钮 = 窗口进入独占的新虚拟桌面（macOS 绿灯行为）
; 再点还原按钮 / 按快捷键 = 回到原桌面并删掉临时桌面
; 依赖 VirtualDesktopAccessor.dll (Ciantic, MIT)，需 Win11 24H2 26100.2605+

; ── 配置 ──────────────────────────────────────────────────────────
TOGGLE_HOTKEY  := "#!f"    ; Win+Alt+F，任何窗口都能用（含 Chrome 等自绘标题栏）
HOOK_MAXBUTTON := false    ; 仅使用 Win+Alt+F，不拦截最大化按钮的点击
BORDERLESS     := false    ; true = 去掉标题栏做真无边框；false = 保留标题栏便于点还原
BYPASS_MOD     := "Shift"  ; 按住它点最大化 = 走系统原生行为

DEBUG          := false    ; true = 写 _debug.txt，排查用

CoordMode "Mouse", "Screen"
DetectHiddenWindows false
SetWinDelay 0

Dbg(s) {
    if DEBUG
        FileAppend(A_TickCount " " s "`n", A_ScriptDir "\_debug.txt")
}

; ── 加载 DLL ──────────────────────────────────────────────────────
DLL := A_ScriptDir "\VirtualDesktopAccessor.dll"
if !FileExist(DLL) {
    MsgBox "缺少 VirtualDesktopAccessor.dll`n应放在：" DLL, "MacFullscreen", 0x10
    ExitApp
}
hMod := DllCall("LoadLibrary", "Str", DLL, "Ptr")
if !hMod {
    MsgBox "DLL 加载失败 (err " A_LastError ")", "MacFullscreen", 0x10
    ExitApp
}
VD := Map()
for n in ["GetDesktopCount", "GetCurrentDesktopNumber", "GetWindowDesktopNumber"
        , "IsWindowOnCurrentVirtualDesktop"
        , "CreateDesktop", "RemoveDesktop", "MoveWindowToDesktopNumber", "GoToDesktopNumber"] {
    if !(p := DllCall("GetProcAddress", "Ptr", hMod, "AStr", n, "Ptr")) {
        MsgBox "DLL 缺少导出函数 " n "`n可能是 Windows 版本不匹配。", "MacFullscreen", 0x10
        ExitApp
    }
    VD[n] := p
}

DesktopCount()      => DllCall(VD["GetDesktopCount"], "Int")
CurrentDesktop()    => DllCall(VD["GetCurrentDesktopNumber"], "Int")
WindowDesktop(hw)   => DllCall(VD["GetWindowDesktopNumber"], "Ptr", hw, "Int")
CreateDesktop()     => DllCall(VD["CreateDesktop"], "Int")
GoToDesktop(i)      => DllCall(VD["GoToDesktopNumber"], "Int", i, "Int")
MoveWinToDesktop(hw, i) => DllCall(VD["MoveWindowToDesktopNumber"], "Ptr", hw, "Int", i, "Int")
RemoveDesktop(i, fb)    => DllCall(VD["RemoveDesktop"], "Int", i, "Int", fb, "Int")
OnCurrentDesktop(hw)    => DllCall(VD["IsWindowOnCurrentVirtualDesktop"], "Ptr", hw, "Int")

; hwnd -> {desk, idx, style, exstyle, wasMax, x, y, w, h}
Tracked := Map()

; ── 判定 ──────────────────────────────────────────────────────────
; 窗口在别的虚拟桌面上时会被标记为不可见，WinExist 在 DetectHiddenWindows false
; 下查不到它。存活判断必须用 IsWindow，不受虚拟桌面和可见性影响。
Alive(hw) => hw && DllCall("IsWindow", "Ptr", hw, "Int")

IsEligible(hw) {
    if !Alive(hw)
        return false
    if DllCall("GetParent", "Ptr", hw, "Ptr")          ; 只处理顶层窗口
        return false
    if WinGetClass(hw) ~= "i)^(Shell_TrayWnd|Shell_SecondaryTrayWnd|Progman|WorkerW|TaskListThumbnailWnd|Windows\.UI\.Core\.CoreWindow)$"
        return false
    if !(WinGetStyle(hw) & 0x10000) && !Tracked.Has(hw) ; WS_MAXIMIZEBOX
        return false
    return true
}

; 光标是否压在最大化/还原按钮上（WM_NCHITTEST -> HTMAXBUTTON）
IsOnMaxButton(hw, x, y) {
    try {
        WinGetPos(&wx, &wy, &ww, &wh, hw)
        if (y > wy + 60 || y < wy - 8 || x < wx || x > wx + ww)  ; 便宜的预筛：只看标题栏带
            return false
        lp := ((y & 0xFFFF) << 16) | (x & 0xFFFF)
        return SendMessage(0x0084, 0, lp, , "ahk_id " hw, , , , 150) = 9
    } catch
        return false
}

OverMaxButton() {
    if (BYPASS_MOD && GetKeyState(BYPASS_MOD, "P"))
        return false
    MouseGetPos &mx, &my, &win
    return IsEligible(win) && IsOnMaxButton(win, mx, my)
}

; ── 绑定 ──────────────────────────────────────────────────────────
Hotkey TOGGLE_HOTKEY, (*) => ToggleFullscreen(WinExist("A"))
HotIf (*) => HOOK_MAXBUTTON && OverMaxButton()
Hotkey "LButton", OnMaxButtonClick
HotIf
SetTimer CleanupOrphans, 3000

; ── 点击处理 ──────────────────────────────────────────────────────
OnMaxButtonClick(*) {
    MouseGetPos &mx, &my, &win
    if !IsEligible(win) {
        Send "{Blind}{LButton down}"      ; 兜底：还原成原生点击
        KeyWait "LButton"
        Send "{Blind}{LButton up}"
        return
    }
    if Tracked.Has(win) {
        ExitFullscreen(win)
        return
    }
    if (WinGetMinMax(win) = 1) {          ; 已最大化 → 此刻是“还原”键，走原生
        WinRestore("ahk_id " win)
        return
    }
    EnterFullscreen(win)
}

; Win11 悬停最大化按钮会弹 Snap Layouts 浮层，进全屏前先关掉
DismissSnapFlyout() {
    if WinExist("ahk_class Windows.UI.Core.CoreWindow ahk_exe ShellExperienceHost.exe")
        PostMessage(0x0010, 0, 0)         ; WM_CLOSE
    Send "{Esc}"
}

ToggleFullscreen(hw) {
    if !IsEligible(hw)
        return
    Tracked.Has(hw) ? ExitFullscreen(hw) : EnterFullscreen(hw)
}

EnterFullscreen(hw) {
    DetectHiddenWindows true               ; 线程局部；跨桌面窗口操作才不会静默失败
    Dbg("ENTER hw=" hw " class=" WinGetClass(hw) " desk=" WindowDesktop(hw)
      . " cur=" CurrentDesktop() " count=" DesktopCount())
    DismissSnapFlyout()
    Dbg("  after DismissSnapFlyout, hw exists=" (WinExist("ahk_id " hw) ? 1 : 0))
    if (WinGetMinMax(hw) = -1)
        WinRestore("ahk_id " hw), Sleep(120)
    ; 原始桌面以当前视图为准：GetWindowDesktopNumber 对刚创建的窗口会返回 0，
    ; 拿它当原始桌面会把窗口还原到错误的桌面。
    origDesk := CurrentDesktop()
    if (OnCurrentDesktop(hw) != 1) {      ; 只有确实不在当前视图上，才查它的桌面号
        wd := WindowDesktop(hw)
        if (wd >= 0 && wd < DesktopCount())
            origDesk := wd
    }
    WinGetPos &x, &y, &w, &h, hw
    st := { desk: origDesk, idx: -1, style: WinGetStyle(hw), exstyle: WinGetExStyle(hw)
          , x: x, y: y, w: w, h: h }

    if ((idx := CreateDesktop()) < 0) {
        Notify("创建虚拟桌面失败")
        return
    }
    st.idx := idx
    Dbg("  created desktop idx=" idx " count=" DesktopCount())
    ; 新桌面需要一点时间在 shell 里登记完，紧接着移动窗口会静默失败
    WaitForDesktop(idx)
    rc := MoveWinToDesktop(hw, idx)
    Dbg("  move rc=" rc " winDesk=" WindowDesktop(hw))
    if (rc < 0) {
        RemoveDesktop(idx, CurrentDesktop())
        Notify("移动窗口到新桌面失败")
        return
    }
    Tracked[hw] := st
    GoToDesktop(idx)
    WaitUntilOn(idx)                      ; 等桌面切换动画落地
    Sleep 80
    Dbg("  after GoToDesktop cur=" CurrentDesktop() " winDesk=" WindowDesktop(hw))
    try WinActivate("ahk_id " hw)
    BORDERLESS ? MakeBorderless(hw) : WinMaximize("ahk_id " hw)
}

ExitFullscreen(hw) {
    DetectHiddenWindows true               ; 同上，可能在别的桌面上触发
    if !Tracked.Has(hw)
        return
    st := Tracked[hw]
    Tracked.Delete(hw)

    if Alive(hw) {
        if BORDERLESS
            RestoreFrame(hw, st)
        else
            WinRestore("ahk_id " hw)
        back := (st.desk >= 0 && st.desk < DesktopCount()) ? st.desk : 0
        MoveWinToDesktop(hw, back)
        GoToDesktop(back)
        WaitUntilOn(back)
        try WinActivate("ahk_id " hw)
    } else {
        back := (st.desk >= 0 && st.desk < DesktopCount()) ? st.desk : 0
        GoToDesktop(back)
        WaitUntilOn(back)
    }
    if (st.idx >= 0 && st.idx < DesktopCount() && DesktopCount() > 1 && st.idx != back) {
        before := DesktopCount()
        RemoveDesktop(st.idx, back)
        if (DesktopCount() < before) {
            ForgetDesktop(st.idx, back)
            if (back > st.idx)
                back -= 1
        }
    }
    Sleep 60
    if (CurrentDesktop() != back)          ; 删桌面偶尔会把视图带走，兜一下
        GoToDesktop(back), WaitUntilOn(back)
}

; 轮询等视图真的切到目标桌面，避免动画未完就删桌面导致视图乱跳
WaitUntilOn(idx, timeoutMs := 1200) {
    deadline := A_TickCount + timeoutMs
    loop {
        if (CurrentDesktop() = idx)
            return true
        Sleep 40
    } until (A_TickCount > deadline)
    return CurrentDesktop() = idx
}

; 轮询等新建的桌面在 shell 里可见（通常一两次就够）
WaitForDesktop(idx, timeoutMs := 800) {
    deadline := A_TickCount + timeoutMs
    loop {
        Sleep 40
        if (DesktopCount() > idx)
            break
    } until (A_TickCount > deadline)
    Sleep 40
}

MakeBorderless(hw) {
    WinSetStyle("-0xC40000", "ahk_id " hw)     ; -WS_CAPTION -WS_THICKFRAME
    mon := GetMonitorRect(hw)
    WinMove(mon.l, mon.t, mon.r - mon.l, mon.b - mon.t, "ahk_id " hw)
}

RestoreFrame(hw, st) {
    WinSetStyle("" st.style, "ahk_id " hw)
    WinSetExStyle("" st.exstyle, "ahk_id " hw)
    WinMove(st.x, st.y, st.w, st.h, "ahk_id " hw)
}

GetMonitorRect(hw) {
    hMon := DllCall("MonitorFromWindow", "Ptr", hw, "UInt", 2, "Ptr")   ; NEAREST
    NumPut("UInt", 40, mi := Buffer(40, 0))
    DllCall("GetMonitorInfo", "Ptr", hMon, "Ptr", mi)
    return { l: NumGet(mi, 4, "Int"),  t: NumGet(mi, 8, "Int")
           , r: NumGet(mi, 12, "Int"), b: NumGet(mi, 16, "Int") }
}

; 窗口被直接关掉时，回收它占用的临时桌面
CleanupOrphans() {
    for hw, st in Tracked.Clone() {
        if Alive(hw)                       ; 切到别的桌面 != 窗口已关闭
            continue
        Tracked.Delete(hw)
        back := (st.desk >= 0 && st.desk < DesktopCount()) ? st.desk : 0
        if (st.idx >= 0 && st.idx < DesktopCount() && DesktopCount() > 1 && st.idx != back) {
            if (CurrentDesktop() = st.idx)
                GoToDesktop(back), Sleep(200)
            before := DesktopCount()
            RemoveDesktop(st.idx, back)
            if (DesktopCount() < before)
                ForgetDesktop(st.idx, back)
        }
    }
}

; 桌面按序号记录。删掉第 r 个后，后面的桌面都前移一位，其他窗口记下的序号要跟着改，
; 否则之后会删错桌面。原桌面正好是被删的那个时，系统把上面的窗口挪到了 fallback，记录也改指向它。
; 用户自己在中间增删桌面时序号仍会错位，这个脚本管不到。
ForgetDesktop(r, fallback) {
    if (fallback > r)
        fallback -= 1
    for hw, st in Tracked {
        if (st.idx > r)
            st.idx -= 1
        if (st.desk = r)
            st.desk := fallback
        else if (st.desk > r)
            st.desk -= 1
    }
}

Notify(msg) => TrayTip(msg, "MacFullscreen", 0x2)

; ── 托盘 ──────────────────────────────────────────────────────────
A_IconTip := "MacFullscreen  (" TOGGLE_HOTKEY " 切换)"
tray := A_TrayMenu
tray.Delete()
tray.Add("退出全屏并清理所有临时桌面", (*) => ExitAllFullscreen())
tray.Add()
tray.Add("拦截最大化按钮", ToggleHookItem)
tray.Add("重新加载", (*) => Reload())
tray.Add("退出", (*) => GracefulExit())
tray.Default := "拦截最大化按钮"
if HOOK_MAXBUTTON
    tray.Check("拦截最大化按钮")

ToggleHookItem(name, *) {
    global HOOK_MAXBUTTON := !HOOK_MAXBUTTON
    A_TrayMenu.ToggleCheck(name)
}

ExitAllFullscreen() {
    for hw in Tracked.Clone()
        ExitFullscreen(hw)
}

GracefulExit() {
    ExitAllFullscreen()
    ExitApp
}

OnExit((*) => ExitAllFullscreen())
