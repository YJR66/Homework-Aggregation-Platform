$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:4317'
$data = Join-Path $root 'data'
$pidFile = Join-Path $data 'server.pid'
$lock = $null
$locked = $false

function Test-Application {
    try { $state = Invoke-RestMethod -Uri "$url/api/state" -TimeoutSec 2 }
    catch { return $false }
    $ids = @($state.platforms | ForEach-Object { $_.id })
    if ($state.version -ne 1 -or $null -eq $state.assignments -or
        @('chaoxing', 'yuketang', 'pta', 'xiji' | Where-Object { $_ -notin $ids }).Count -gt 0) {
        throw '4317 端口被其他服务占用，请先关闭该服务。'
    }
    return $true
}

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
    # Serialize double-clicks without trusting a potentially stale PID file.
    $lock = New-Object System.Threading.Mutex($false, 'Local\HomeworkHubStartup4317')
    try { $locked = $lock.WaitOne(30000) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '另一次启动仍在进行，请稍后重试。' }
    Set-Location -LiteralPath $root
    $running = Test-Application
    if (-not $running) {
        if (Test-LocalPort) { throw '4317 端口已有服务，但健康检查未通过。请稍后重试或检查 data/server-error.log。' }
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw '请安装 Node.js 22 或更新版本，再重新启动。' }
        $version = & $node.Source --version
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
            throw '请安装 Node.js 22 或更新版本，再重新启动。'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules/playwright')) -or
            -not (Test-Path -LiteralPath (Join-Path $root 'node_modules/nodemailer'))) {
            $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $npm) { throw '未找到 npm，请重新安装 Node.js。' }
            & $npm.Source ci
            if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
        }
        New-Item -ItemType Directory -Force -Path $data | Out-Null
        # The desktop launcher always uses the documented default port.
        $hadPort = Test-Path Env:PORT
        $oldPort = $env:PORT
        try {
            $env:PORT = '4317'
            $process = Start-Process -FilePath $node.Source -ArgumentList 'server/index.mjs' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'server.log') -RedirectStandardError (Join-Path $data 'server-error.log') -PassThru
        } finally {
            if ($hadPort) { $env:PORT = $oldPort } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }
        }
        Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding Ascii
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            if ($process.HasExited) { break }
            if (Test-Application) { $running = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $running) {
            if ($process.HasExited) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
            throw '服务启动失败，请检查 data/server-error.log；确认 4317 端口未被其他服务占用。'
        }
    }
    Write-Host "作业聚合系统已启动：$url"
    try { Start-Process $url }
    catch { Write-Host "浏览器未能自动打开，请手动访问 $url" }
} catch {
    Write-Host ("启动失败：" + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $lock.ReleaseMutex() }
    if ($null -ne $lock) { $lock.Dispose() }
}
