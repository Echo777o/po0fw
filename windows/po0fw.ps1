# po0fw - po0 防火墙自动加白 (Windows)
# 用法: powershell -File po0fw.ps1 -Tokens "pgnfw_xxx,pgnfw_yyy@0"
param(
    [string]$Tokens = $env:PO0FW_TOKENS,
    [string]$ApiBase = "https://console.po0.io/modules/servers/penguin/api/firewall.php"
)

$confPath = Join-Path $env:ProgramData "po0fw\po0fw.conf"
if (-not $Tokens -and (Test-Path $confPath)) {
    $Tokens = (Get-Content $confPath -Raw).Trim()
}
if (-not $Tokens) {
    Write-Error "未配置 token。用 -Tokens 参数或写入 $confPath"
    exit 1
}

function Get-ExitIP {
    foreach ($u in @("https://api-ipv4.ip.sb/ip", "https://ipv4.icanhazip.com", "https://api.ipify.org")) {
        try {
            $ip = (Invoke-RestMethod -Uri $u -TimeoutSec 15).ToString().Trim()
            if ($ip -match '^\d+\.\d+\.\d+\.\d+$') { return $ip }
        } catch { continue }
    }
    return $null
}

$ip = Get-ExitIP
if (-not $ip) { Write-Error "无法探测出口 IPv4"; exit 1 }
$parts = $ip.Split('.')
$net = "$($parts[0]).$($parts[1]).$($parts[2]).0/24"
Write-Host "[po0fw] 出口 IP: $ip (网段 $net)"

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
    try {
        $st = Invoke-RestMethod -Uri "$ApiBase?action=status&token=$tok" -TimeoutSec 20
    } catch {
        Write-Host "[po0fw] #$idx $short… ❌ status 失败: $_"
        $fail = $true; continue
    }
    if ($st.whitelist | Where-Object { $_.ip -eq $net }) {
        Write-Host "[po0fw] #$idx $short… ✅ $net 已在白名单，跳过"
        continue
    }
    $url = "$ApiBase?action=add&token=$tok"
    if ($slot) { $url += "&slot=$slot" }
    try {
        $res = Invoke-RestMethod -Uri $url -TimeoutSec 20
        Write-Host "[po0fw] #$idx $short… ➕ 已加白 $net"
    } catch {
        Write-Host "[po0fw] #$idx $short… ❌ 加白失败: $_"
        $fail = $true
    }
}
if ($fail) { exit 1 }
