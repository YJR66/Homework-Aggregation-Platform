$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:4317'
$pidFile = Join-Path $root 'data/server.pid'

function Test-LocalPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $attempt = $client.BeginConnect('127.0.0.1', 4317, $null, $null)
        if (-not $attempt.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($attempt)
        return $client.Connected
    } catch { return $false }
    finally { $client.Close() }
}

try {
    if (-not (Test-LocalPort)) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host '作业聚合服务未运行。'
        exit 0
    }
    # Validate the local application before asking it to save and close.
    $state = Invoke-RestMethod -Uri "$url/api/state" -TimeoutSec 5
    $ids = @($state.platforms | ForEach-Object { $_.id })
    if ($state.version -ne 1 -or $null -eq $state.assignments -or
        @('chaoxing', 'yuketang', 'pta', 'xiji' | Where-Object { $_ -notin $ids }).Count -gt 0) {
        throw '4317 端口不是作业聚合服务，未执行停止操作。'
    }
    $result = Invoke-RestMethod -Uri "$url/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    if ($result.ok -ne $true) { throw '服务没有确认停止请求。' }
    Write-Host '正在保存登录态并停止作业聚合服务…'
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-LocalPort)) {
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
            Write-Host '作业聚合服务已停止。'
            exit 0
        }
        Start-Sleep -Milliseconds 300
    }
    throw '服务尚未完成保存和停止，请稍后重试；未强行终止进程。'
} catch {
    Write-Host ("停止失败：" + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
