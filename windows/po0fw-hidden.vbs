' po0fw silent launcher
' Starting powershell.exe directly can briefly create a conhost window before
' -WindowStyle Hidden takes effect. wscript.exe has no console, so use it to
' launch the PowerShell worker without a visible window.
Option Explicit

Dim shell, fso, scriptDir, ps1, args, i, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "po0fw.ps1")

' Forward script arguments such as -Status.
args = ""
For i = 0 To WScript.Arguments.Count - 1
    args = args & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden " & _
      "-ExecutionPolicy Bypass -File """ & ps1 & """" & args

' 0 = hidden window; False = do not wait for completion.
shell.Run cmd, 0, False
