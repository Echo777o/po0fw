# po0fw Windows 一键安装（需管理员 PowerShell）
# 用法: powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Tokens "pgnfw_xxx"
param(
    [Parameter(Mandatory = $true)][string]$Tokens,
    [string]$RawBase = "https://raw.githubusercontent.com/kelenetwork/po0fw/main"
)

$dir = Join-Path $env:ProgramData "po0fw"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "[1/3] 下载主脚本 -> $dir"
foreach ($f in @("po0fw.ps1", "po0fw-hidden.vbs")) {
    $local = Join-Path $PSScriptRoot $f
    if (Test-Path $local) {
        Copy-Item $local (Join-Path $dir $f) -Force
    } else {
        Invoke-WebRequest -Uri "$RawBase/windows/$f" -OutFile (Join-Path $dir $f)
    }
}

Write-Host "[2/3] 写配置"
Set-Content -Path (Join-Path $dir "po0fw.conf") -Value $Tokens -Encoding UTF8

Write-Host "[3/3] 注册计划任务（每 10 分钟 + 网络切换，全程无窗口）"
# 经 wscript.exe 拉起：powershell.exe 直接跑会先创建 conhost 控制台窗口再隐藏，
# 表现为定时闪黑框；wscript 本身无控制台，可做到完全静默。
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$dir\po0fw-hidden.vbs`" //B //Nologo"
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
# 网络状态变化事件触发 (NetworkProfile 10000/10001)
$class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$t2 = New-CimInstance -CimClass $class -ClientOnly
$t2.Subscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000)]]</Select></Query></QueryList>'
$t2.Enabled = $true
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
Register-ScheduledTask -TaskName "po0fw" -Action $action -Trigger @($t1, $t2) `
    -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "安装完成，立即执行一次:"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "po0fw.ps1")

Write-Host ""
Write-Host "查看白名单状态: powershell -File `"$dir\po0fw.ps1`" -Status"
