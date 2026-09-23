param([string]$PythonPath = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'data\ocr-venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$marker = Join-Path $venv 'ocr-ready.json'
# Use an existing supported Python and keep the OCR environment under ignored
# local data. Never install the model into the user's global Python.
$candidates = @()
if ($PythonPath) { $candidates += $PythonPath }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe') }
if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe') }
$command = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $candidates += $command.Source }
$python = $null
foreach ($candidate in $candidates) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    $info = ((& $candidate -c 'import sys,struct;print(sys.version_info[0],sys.version_info[1],struct.calcsize(''P'')*8)' 2>$null) -join '').Trim() -split '\s+'
    if ($LASTEXITCODE -eq 0 -and $info.Length -eq 3 -and [int]$info[0] -eq 3 -and [int]$info[1] -ge 10 -and [int]$info[1] -le 12 -and [int]$info[2] -eq 64) { $python = $candidate; break }
  } catch {}
}
if (-not $python) { throw '需要现有的 64 位 Python 3.10-3.12。可通过 -PythonPath 指定；不会改动全局 Python。' }
# Remove the readiness marker before changing dependencies so a failed update
# cannot leave a stale "OCR available" signal for the server.
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
if (-not (Test-Path -LiteralPath $venvPython)) {
  & $python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建本地 OCR 虚拟环境失败。' }
}
& $venvPython -m pip install --disable-pip-version-check --only-binary=:all: --index-url https://pypi.org/simple -r (Join-Path $root 'requirements-ocr.txt')
if ($LASTEXITCODE -ne 0) { throw '安装本地 OCR 依赖失败。' }
$checkOutput = & $venvPython -u (Join-Path $PSScriptRoot 'ocr_worker.py') --check
if ($LASTEXITCODE -ne 0) { throw 'OCR 模型启动自检失败。' }
$check = $checkOutput | ConvertFrom-Json
if ($check.available -ne $true -or $check.engine -ne 'ddddocr' -or $check.version -ne '1.5.6') { throw 'OCR 模型自检结果不符合预期。' }
[IO.File]::WriteAllText($marker, ($check | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
Write-Host '本地 CPU 验证码 OCR 已安装并通过自检。图片只在本机内存处理。'
