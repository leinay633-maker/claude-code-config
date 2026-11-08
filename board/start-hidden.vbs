Option Explicit
Dim shell, fso, folder, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = shell.Environment("PROCESS")
If env("CLAUDE_BOARD_DIR") = "" Then env("CLAUDE_BOARD_DIR") = folder
shell.CurrentDirectory = folder
shell.Run "node """ & fso.BuildPath(folder, "board-server.js") & """", 0, False
