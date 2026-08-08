#requires -Version 5.1
# po0fw - po0 防火墙自动加白 (Windows)
# 用法: powershell -File po0fw.ps1 -Tokens "pgnfw_xxx,pgnfw_yyy@0"
param(
    [string]$Tokens = $env:PO0FW_TOKENS,
    [string]$ApiBase = "https://124.221.69.228/api/firewall",
    [switch]$Status
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
    try {
        if ($Status) {
            # 只读端点：GET <base>/<token>（不带 /add）。
            # 切勿改回 POST .../add —— 当前 IP 不在白名单时，add 会真的写入并
            # 占掉一个 FIFO 坑位、顶掉最旧记录，status 必须只看不改。
            $res = Invoke-RestMethod -Method Get -Uri "$ApiBase/$tok" -TimeoutSec 20
        } else {
            $url = "$ApiBase/$tok/add"
            if ($slot) { $url += "?slot=$slot" }
            $res = Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 20
        }
    } catch {
        $verb = if ($Status) { "查询失败" } else { "请求失败" }
        Write-Host "[po0fw] #$idx $short… ❌ ${verb}: $_"
        $fail = $true; continue
    }
    $cur = $res.currentIp
    $inList = $cur -and ($res.whitelist | Where-Object { $_.ip -eq $cur })

    if ($Status) {
        $limit = if ($res.limit) { $res.limit } else { 5 }
        $currentDisplay = if ($cur) { $cur } else { '未知' }
        Write-Host "[po0fw] #$idx $short… 当前出口 $currentDisplay"
        $n = 0
        foreach ($e in $res.whitelist) {
            $mark = if ($cur -and $e.ip -eq $cur) { '->' } else { '  ' }
            # slot 为 null = 普通 FIFO 记录；数字 = 被钉死的固定槽位（下标不等于槽位号）
            $kind = if ($null -eq $e.slot) {
                '(普通，参与 FIFO 淘汰)'
            } else {
                "(固定槽位 $($e.slot)，不淘汰)"
            }
            Write-Host "[po0fw]     $mark $($e.ip)  $kind"
            $n++
        }
        if ($n -eq 0) { Write-Host "[po0fw]     (白名单为空)" }
        Write-Host "[po0fw]     共 $n/$limit 个网段占用"
        if ($inList) {
            Write-Host "[po0fw] #$idx $short… ✅ 当前出口已在白名单"
        } else {
            Write-Host "[po0fw] #$idx $short… ⚠️  当前出口不在白名单（status 不会自动加白，需要时请跑不带 -Status 的命令）"
            $fail = $true
        }
        continue
    }

    if ($inList) {
        $slotDisplay = if ($slot) { " (槽位 $slot)" } else { "" }
        Write-Host "[po0fw] #$idx $short… ✅ 出口 $cur 已在白名单$slotDisplay"
    } else {
        Write-Host "[po0fw] #$idx $short… ❌ 加白未生效 (currentIp=$cur)"
        $fail = $true
    }
}
if ($fail) { exit 1 }
