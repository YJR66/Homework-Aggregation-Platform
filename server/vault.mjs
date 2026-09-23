import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './store.mjs';

export function dpapi(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('账号加密保存使用 Windows DPAPI；其他系统请直接在浏览器登录。');
  return new Promise((resolve, reject) => {
    // Send plaintext through stdin only; command arguments and logs never contain it.
    const expression = decrypt
      ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
      : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Console]::Out.Write(${expression})`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { output += d; }); child.stderr.resume();
    child.on('error', () => reject(new Error('Windows 凭据加密服务启动失败。')));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('凭据加密/解密失败，请在当前 Windows 账户重新配置。')));
    child.stdin.on('error', () => {}); child.stdin.end(value);
  });
}

export class Vault {
  constructor(dataDir) { this.filename = path.join(dataDir, 'credentials.dpapi.json'); this.values = {}; this.queue = Promise.resolve(); }
  async init() {
    try { const data = JSON.parse(await readFile(this.filename, 'utf8')); this.values = JSON.parse(await dpapi(data.ciphertext, true)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  get(id) { return this.values[id] || {}; }
  configured(id) { const v = this.get(id); return Boolean(v.username && v.password); }
  async set(id, credentials) {
    // Encrypt and atomically write before publishing the new in-memory value.
    // The queue prevents concurrent platform updates from overwriting each other.
    this.queue = this.queue.catch(() => {}).then(async () => {
      const next = { ...this.values, [id]: { ...this.get(id), ...credentials } };
      await atomicWrite(this.filename, JSON.stringify({ version: 1, scheme: 'Windows-DPAPI-CurrentUser', ciphertext: await dpapi(JSON.stringify(next)) }, null, 2));
      this.values = next;
    });
    await this.queue;
  }
  redact(message) {
    let text = String(message);
    for (const cred of Object.values(this.values)) for (const secret of Object.values(cred)) if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[已隐藏]');
    return text.slice(0, 500);
  }
}

export async function saveBrowserState(dataDir, id, context) {
  if (!/^(chaoxing|yuketang|pta|xiji)$/.test(id)) throw new Error('未知平台。');
  const state = await context.storageState();
  // Persistent Chromium profiles already retain localStorage. Only session cookies
  // need restoration; replaying old localStorage on navigation would undo logout.
  await atomicWrite(path.join(dataDir, `session-${id}.dpapi`), await dpapi(JSON.stringify({ cookies: state.cookies })));
}

export async function restoreBrowserState(dataDir, id, context) {
  if (!/^(chaoxing|yuketang|pta|xiji)$/.test(id)) throw new Error('未知平台。');
  let state;
  try { state = JSON.parse(await dpapi(await readFile(path.join(dataDir, `session-${id}.dpapi`), 'utf8'), true)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (state.cookies?.length) await context.addCookies(state.cookies);
}
