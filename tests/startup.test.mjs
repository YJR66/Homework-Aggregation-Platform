import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(new URL(`../${name}`, import.meta.url));

test('Windows command wrappers use ASCII helper paths and preserve failure', async () => {
  for (const [name, helper] of [['启动.cmd', 'start'], ['停止.cmd', 'stop']]) {
    const raw = await read(name);
    assert.ok(raw.every(byte => byte < 128));
    const text = raw.toString('ascii');
    assert.ok(text.includes(`%~dp0scripts\\${helper}.ps1`));
    assert.match(text, /if errorlevel 1/i);
    assert.match(text, /exit \/b 1/i);
  }
});

test('Chinese PowerShell helper text has a Windows PowerShell compatible BOM', async () => {
  for (const name of ['scripts/start.ps1', 'scripts/stop.ps1']) {
    const raw = await read(name);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  }
  for (const name of ['启动.ps1', '停止.ps1']) {
    assert.ok((await read(name)).every(byte => byte < 128));
  }
});

test('launcher keeps the server hidden and serializes default-port health checks', async () => {
  const text = (await read('scripts/start.ps1')).toString('utf8');
  assert.match(text, /127\.0\.0\.1:4317/);
  assert.match(text, /System\.Threading\.Mutex/);
  assert.match(text, /WaitOne\(30000\)/);
  assert.match(text, /ReleaseMutex\(\)/);
  assert.match(text, /Start-Process[^\r\n]+-WindowStyle Hidden/);
  assert.match(text, /Set-Content -LiteralPath \$pidFile -Value \$process\.Id/);
  assert.match(text, /\$env:PORT = '4317'/);
  assert.ok(text.indexOf('$running = Test-Application') < text.indexOf('Get-Command node'));
  assert.match(text, /\$node = Get-Command node[^\r\n]+\| Select-Object -First 1/);
  assert.match(text, /\$npm = Get-Command npm\.cmd[^\r\n]+\| Select-Object -First 1/);
  assert.match(text, /node_modules\/nodemailer/);
});

test('stop requests a validated graceful shutdown and never kills a stored PID', async () => {
  const text = (await read('scripts/stop.ps1')).toString('utf8');
  assert.match(text, /api\/shutdown" -Method Post/);
  assert.match(text, /api\/state/);
  assert.match(text, /AddSeconds\(60\)/);
  assert.doesNotMatch(text, /Stop-Process|taskkill|Get-Process|Get-Content/i);
});

test('Windows PowerShell parses all launch scripts without executing them', { skip: process.platform !== 'win32' }, () => {
  const escapedRoot = root.replaceAll("'", "''");
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; foreach ($name in @('启动.ps1','停止.ps1','scripts/start.ps1','scripts/stop.ps1')) { $tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path '${escapedRoot}' $name),[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 } }`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
