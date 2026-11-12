$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3000'
$token = 'eFO8u-qEFYFq6YWDtQshgpoM0y3tLZLE8xj4F4THQEo'
$h = @{ Authorization = "Bearer $token" }

function Get-Json($action, $query = '') {
    $u = "$base/$action" + "?access_token=$token" + $query
    try {
        return (Invoke-WebRequest $u -Headers $h -UseBasicParsing -TimeoutSec 12).Content
    } catch {
        $t = ''
        if ($_.Exception.Response) { $t = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
        return "ERR $($_.Exception.Message) $t"
    }
}

Write-Output "[watch] started $(Get-Date -Format HH:mm:ss) — 等待 1599683156 的好友申请"
for ($i = 1; $i -le 120; $i++) {
    $raw = Get-Json 'get_doubt_friends_add_request' '&count=50'
    if ($raw -and $raw -notlike 'ERR*') {
        try { $j = $raw | ConvertFrom-Json } catch { $j = $null }
        if ($j -and $j.data -and @($j.data).Count -gt 0) {
            Write-Output "=== 收到待处理请求 @ $(Get-Date -Format HH:mm:ss) ==="
            Write-Output $raw
            foreach ($req in @($j.data)) {
                $flag = $null
                foreach ($name in 'flag', 'id', 'request_id', 'seq', 'messageId') {
                    if ($req.PSObject.Properties.Name -contains $name -and $req.$name) { $flag = [string]$req.$name; break }
                }
                if ($flag) {
                    $act = 'set_friend_add_request'
                    $body = @{ flag = $flag; approve = $true } | ConvertTo-Json
                    try {
                        $r = Invoke-WebRequest "$base/$act" -Method Post -ContentType 'application/json' -Body $body -Headers $h -UseBasicParsing -TimeoutSec 15
                        Write-Output "APPROVE($act flag=$flag) -> $($r.Content)"
                    } catch {
                        $t = ''
                        if ($_.Exception.Response) { $t = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
                        Write-Output "APPROVE($act flag=$flag) FAIL -> $($t)"
                    }
                } else {
                    Write-Output "!! 找到请求但没有可用的 flag 字段，需人工处理"
                }
            }
            Write-Output "=== 好友列表 ==="
            Write-Output (Get-Json 'get_friend_list')
            break
        }
    } elseif ($raw -like 'ERR*') {
        Write-Output "poll $i error: $raw"
    }
    Start-Sleep -Seconds 5
}
Write-Output "[watch] done $(Get-Date -Format HH:mm:ss)"
