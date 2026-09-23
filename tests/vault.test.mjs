import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, dpapi, saveBrowserState, restoreBrowserState } from '../server/vault.mjs';

const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows DPAPI is unavailable on this platform.' : false };
const fakeCredentials = Object.freeze({ username: 'fixture-user-only', password: 'fixture-password-汉字-Ω', vpnUsername: 'fixture-school-user', vpnPassword: 'fixture-school-secret' });

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'homework-vault-test-'));
}
async function removeTemporaryDirectory(dir) {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('homework-vault-test-'));
  await rm(target, { recursive: true, force: true });
}
function fakeBrowserState() {
  return {
    cookies: [
      { name: 'fixture_session', value: 'fake-cookie-value-only', domain: 'pintia.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ],
    origins: [
      { origin: 'https://pintia.cn', localStorage: [{ name: 'token', value: 'fake-platform-token-only' }, { name: 'preference', value: 'stored-preference' }] },
      { origin: 'https://vpn.neuq.edu.cn', localStorage: [{ name: 'token', value: 'fake-school-token-only' }] },
    ],
  };
}
test('Windows DPAPI round-trips Unicode without exposing plaintext', windowsOnly, async () => {
  const plaintext = JSON.stringify(fakeCredentials);
  const ciphertext = await dpapi(plaintext);
  assert.match(ciphertext, /^[A-Za-z0-9+/]+=*$/);
  for (const secret of Object.values(fakeCredentials)) assert.ok(!ciphertext.includes(secret));
  assert.equal(await dpapi(ciphertext, true), plaintext);
});

test('vault persists only encrypted payload and reloads credentials under the current user', windowsOnly, async () => {
  const dir = await temporaryDirectory();
  try {
    const vault = await new Vault(dir).init();
    assert.equal(vault.configured('xiji'), false);
    await vault.set('xiji', fakeCredentials);
    const text = await readFile(vault.filename, 'utf8');
    const envelope = JSON.parse(text);
    assert.equal(envelope.scheme, 'Windows-DPAPI-CurrentUser');
    assert.equal(envelope.version, 1);
    assert.ok(envelope.ciphertext.length > 50);
    for (const secret of Object.values(fakeCredentials)) assert.ok(!text.includes(secret));
    const reloaded = await new Vault(dir).init();
    assert.equal(reloaded.configured('xiji'), true);
    assert.deepEqual(reloaded.get('xiji'), fakeCredentials);
    assert.deepEqual(reloaded.get('missing-platform'), {});
  } finally { await removeTemporaryDirectory(dir); }
});

test('vault write failures preserve both committed memory and the previous encrypted file', windowsOnly, async () => {
  const dir = await temporaryDirectory();
  try {
    const vault = await new Vault(dir).init();
    await vault.set('pta', fakeCredentials);
    const filename = vault.filename;
    const committed = structuredClone(vault.values);
    const disk = await readFile(filename, 'utf8');
    const blocker = path.join(dir, 'not-a-file');
    await mkdir(blocker);
    vault.filename = blocker;
    await assert.rejects(vault.set('pta', { password: 'uncommitted-fake-secret' }));
    assert.deepEqual(vault.values, committed);
    assert.equal(await readFile(filename, 'utf8'), disk);
    assert.equal((await readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
    vault.filename = filename;
    await vault.set('pta', { password: 'recovered-fake-secret' });
    const reloaded = await new Vault(dir).init();
    assert.equal(reloaded.get('pta').password, 'recovered-fake-secret');
    assert.equal(reloaded.get('pta').username, fakeCredentials.username);
  } finally { await removeTemporaryDirectory(dir); }
});

test('concurrent vault updates retain both platform records and ordered updates', windowsOnly, async () => {
  const dir = await temporaryDirectory();
  try {
    const vault = await new Vault(dir).init();
    await Promise.all([
      vault.set('pta', { username: 'first-fixture-user', password: 'first-fixture-secret' }),
      vault.set('chaoxing', { username: 'second-fixture-user', password: 'second-fixture-secret' }),
      vault.set('pta', { password: 'replacement-fixture-secret' }),
    ]);
    const reloaded = await new Vault(dir).init();
    assert.deepEqual(reloaded.values, vault.values);
    assert.equal(reloaded.get('pta').username, 'first-fixture-user');
    assert.equal(reloaded.get('pta').password, 'replacement-fixture-secret');
    assert.equal(reloaded.get('chaoxing').password, 'second-fixture-secret');
  } finally { await removeTemporaryDirectory(dir); }
});

test('encrypted session backups restore cookies without replaying localStorage into any origin', windowsOnly, async () => {
  const dir = await temporaryDirectory();
  try {
    const state = fakeBrowserState();
    let reads = 0;
    await saveBrowserState(dir, 'pta', { storageState: async () => { reads++; return state; } });
    assert.equal(reads, 1);
    const text = await readFile(path.join(dir, 'session-pta.dpapi'), 'utf8');
    for (const secret of ['fake-cookie-value-only', 'fake-platform-token-only', 'fake-school-token-only', 'fixture_session', 'pintia.cn']) assert.ok(!text.includes(secret));
    assert.deepEqual(JSON.parse(await dpapi(text, true)), { cookies: state.cookies });
    const cookies = [];
    const scripts = [];
    const context = {
      addCookies: async value => { cookies.push(structuredClone(value)); },
      addInitScript: async (callback, argument) => { scripts.push({ callback, argument }); },
    };
    await restoreBrowserState(dir, 'pta', context);
    assert.deepEqual(cookies, [state.cookies]);
    assert.equal(scripts.length, 0);
    // Old backups may contain multiple origins. They must never reinstall tokens
    // on navigation, cross origins, or resurrect values removed by a later logout.
    await writeFile(path.join(dir, 'session-pta.dpapi'), await dpapi(JSON.stringify(state)));
    await restoreBrowserState(dir, 'pta', context);
    assert.equal(scripts.length, 0);
    assert.deepEqual(cookies, [state.cookies, state.cookies]);
  } finally { await removeTemporaryDirectory(dir); }
});

test('missing sessions are a no-op; invalid platform paths fail before touching contexts', async () => {
  const dir = await temporaryDirectory();
  try {
    const context = {
      storageState: async () => { throw new Error('Unexpected browser state read'); },
      addCookies: async () => { throw new Error('Unexpected cookie restoration'); },
      addInitScript: async () => { throw new Error('Unexpected script installation'); },
    };
    await restoreBrowserState(dir, 'pta', context);
    for (const id of ['../pta', 'pta/../../xiji', 'unknown', '', '__proto__']) {
      await assert.rejects(saveBrowserState(dir, id, context), /未知平台/);
      await assert.rejects(restoreBrowserState(dir, id, context), /未知平台/);
    }
  } finally { await removeTemporaryDirectory(dir); }
});

test('corrupt encrypted session fails without installing partial browser state', windowsOnly, async () => {
  const dir = await temporaryDirectory();
  try {
    await writeFile(path.join(dir, 'session-pta.dpapi'), 'not-a-valid-encrypted-state');
    const effects = [];
    await assert.rejects(restoreBrowserState(dir, 'pta', {
      addCookies: async () => { effects.push('cookies'); },
      addInitScript: async () => { effects.push('script'); },
    }));
    assert.deepEqual(effects, []);
  } finally { await removeTemporaryDirectory(dir); }
});

test('redaction removes stored account/password fields and caps diagnostic length', () => {
  const vault = new Vault(path.join(os.tmpdir(), 'unused-vault-redaction-fixture'));
  vault.values = { xiji: { ...fakeCredentials } };
  const result = vault.redact(`Fixture failure: ${Object.values(fakeCredentials).join(' / ')} / ${fakeCredentials.password}`);
  for (const secret of Object.values(fakeCredentials)) assert.ok(!result.includes(secret));
  assert.equal((result.match(/\[已隐藏\]/g) || []).length, 5);
  assert.ok(vault.redact('x'.repeat(1000)).length <= 500);
});
