' qq-bridge 静默启动器（0.4.100）
'
' 为什么需要它：计划任务里写 powershell.exe -WindowStyle Hidden **依然会闪一下黑框** ——
' 因为 -WindowStyle 是在 conhost 启动之后才生效的。彻底的做法是用 wscript 以 0 号窗口样式
' 启动子进程：窗口从头到尾不创建。
'
' 用法（任务里）：
'   wscript.exe //B "scripts\hidden-launch.vbs" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\...\keepalive.ps1""
'
' 参数 1 = 要执行的完整命令行（含引号），其余参数忽略。

Option Explicit

Dim cmd, shell, rc
If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

cmd = WScript.Arguments(0)
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next

Set shell = CreateObject("WScript.Shell")
' 0 = 隐藏窗口，False = 不等待
rc = shell.Run(cmd, 0, False)
WScript.Quit 0
