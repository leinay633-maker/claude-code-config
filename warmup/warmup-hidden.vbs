' Run warmup.ps1 next to this file with Windows PowerShell 5.1 and no window. Used by the claude-warmup scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "warmup.ps1")
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, True
