Option Explicit

Dim shell, fs, folder, python, command, i, rc
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
folder = fs.GetParentFolderName(WScript.ScriptFullName)
python = shell.Environment("PROCESS")("AI_BRIEFING_PYTHON")
If Len(python) = 0 Then python = "python"
If WScript.Arguments.Count > 0 Then python = WScript.Arguments(0)
command = QuoteArg(python) & " -X utf8 " & QuoteArg(fs.BuildPath(folder, "briefing.py"))
For i = 1 To WScript.Arguments.Count - 1
    command = command & " " & QuoteArg(WScript.Arguments(i))
Next
shell.CurrentDirectory = folder
On Error Resume Next
rc = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
On Error GoTo 0
WScript.Quit rc

Function QuoteArg(value)
    Dim result, slashes, j, ch
    result = Chr(34)
    slashes = 0
    For j = 1 To Len(value)
        ch = Mid(value, j, 1)
        If ch = "\" Then
            slashes = slashes + 1
        ElseIf ch = Chr(34) Then
            result = result & String(2 * slashes + 1, "\") & ch
            slashes = 0
        Else
            result = result & String(slashes, "\") & ch
            slashes = 0
        End If
    Next
    QuoteArg = result & String(2 * slashes, "\") & Chr(34)
End Function
