# po0fw - po0 防火墙自动加白 (Windows)
# 用法: powershell -File po0fw.ps1 -Tokens "pgnfw_xxx,pgnfw_yyy@0"
param(
    [string]$Tokens = $env:PO0FW_TOKENS,
    [string]$ApiBase = "https://124.221.69.228/api/firewall"
)

$confPath = Join-Path $env:ProgramData "po0fw\po0fw.conf"
if (-not $Tokens -and (Test-Path $confPath)) {
    $Tokens = (Get-Content $confPath -Raw).Trim()
}
if (-not $Tokens) {
    Write-Error "未配置 token。用 -Tokens 参数或写入 $confPath"
    exit 1
}

# 官方端点为 IP 证书（SAN=IP），Invoke-RestMethod 可正常校验；强制 TLS1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072

$fail = $false
$idx = 0
foreach ($entry in $Tokens.Split(',')) {
    $idx++
    $entry = $entry.Trim()
    if (-not $entry) { continue }
    $slot = $null
    $tok = $entry
    if ($entry.Contains('@')) {
        $tok, $slot = $entry.Split('@', 2)
    }
    $short = $tok.Substring(0, [Math]::Min(12, $tok.Length))
    $url = "$ApiBase/$tok/add"
    if ($slot) { $url += "?slot=$slot" }
    try {
        $res = Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 20
    } catch {
        Write-Host "[po0fw] #$idx $short… ❌ 请求失败: $_"
        $fail = $true; continue
    }
    $cur = $res.currentIp
    if ($cur -and ($res.whitelist | Where-Object { $_.ip -eq $cur })) {
        Write-Host "[po0fw] #$idx $short… ✅ 出口 $cur 已在白名单$(if ($slot) { " (槽位 $slot)" })"
    } else {
        Write-Host "[po0fw] #$idx $short… ❌ 加白未生效 (currentIp=$cur)"
        $fail = $true
    }
}
if ($fail) { exit 1 }
