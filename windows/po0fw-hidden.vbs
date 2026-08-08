' po0fw 静默启动器
' 计划任务直接跑 powershell.exe 时，即使加了 -WindowStyle Hidden，
' 控制台宿主 (conhost.exe) 仍会先创建窗口再被隐藏，表现为定时闪黑框。
' wscript.exe 本身无控制台，用 Run(..., 0, False) 拉起 PowerShell 可完全无窗口。
Option Explicit

Dim shell, fso, scriptDir, ps1, args, i, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "po0fw.ps1")

' 透传本脚本收到的参数（例如 -Status）
args = ""
For i = 0 To WScript.Arguments.Count - 1
    args = args & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden " & _
      "-ExecutionPolicy Bypass -File """ & ps1 & """" & args

' 0 = 隐藏窗口, False = 不等待返回
shell.Run cmd, 0, False
