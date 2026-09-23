import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.mjs';

const USER = 'fixture-auth-user';
const PASSWORD = 'fixture-auth-password-never-echo';
const VPN_PASSWORD = 'fixture-vpn-password-never-echo';
const oldItem = { externalId: 'preserved-auth-task', title: '登录失败时仍保留的作业', course: '课程', status: 'pending' };
const newItem = { externalId: 'new-auth-task', title: '登录验证后读取的作业', course: '课程', status: 'pending' };
const OK = { authenticated: true, reason: '已验证个人课程页面。' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, handlers = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-auth-api-'));
  const secrets = { pta: { username: USER, password: PASSWORD, vpnPassword: VPN_PASSWORD } };
  const calls = { auth: [], verify: [], collect: [], goto: [], reset: [], saved: [], close: 0 };
  const gates = [];
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  let options;
  const vault = {
    get: id => ({ ...(secrets[id] || {}) }),
    configured: id => Boolean(secrets[id]?.username && secrets[id]?.password),
    set: async (id, value) => {
      calls.saved.push({ id, value });
      await handlers.save?.(id, value);
      secrets[id] = { ...secrets[id], ...value };
    },
    redact: value => {
      let result = String(value ?? '');
      for (const credential of Object.values(secrets)) for (const secret of Object.values(credential)) if (typeof secret === 'string' && secret) result = result.replaceAll(secret, '[已隐藏]');
      return result;
    },
  };
  const recordAuth = (platform, result) => {
    options.onStatus(platform.id, {
      loginStatus: result.authenticated === true ? 'authenticated' : result.invalidCredentials ? 'invalid_credentials' : result.challengeType ? 'challenge' : result.authenticated === false ? 'expired' : 'unknown',
      authMessage: result.reason,
      lastAuthCheckAt: new Date().toISOString(),
    });
    return result;
  };
  const app = await createApplication({
    dataDir: dir, vault,
    browserFactory: value => {
      options = value;
      return {
        browserAvailable: true, ocrAvailable: true, isOpen: () => false,
        getSession: async () => ({ context: {}, page: { goto: async url => { calls.goto.push(url); } } }),
        authenticate: async (platform, authOptions) => {
          calls.auth.push({ platform: platform.id, options: authOptions });
          return recordAuth(platform, handlers.auth ? await handlers.auth(platform, authOptions, calls) : OK);
        },
        verifySession: async platform => {
          calls.verify.push(platform.id);
          return recordAuth(platform, handlers.verify ? await handlers.verify(platform, calls) : OK);
        },
        resetLoginAttempts: id => { calls.reset.push(id); },
        close: async () => { calls.close++; },
      };
    },
    collector: async args => {
      calls.collect.push(args.platform.id);
      return handlers.collect ? handlers.collect(args, calls) : { authenticated: true, complete: true, assignments: [newItem], message: '完整读取成功。' };
    },
  });
  t.after(async () => {
    for (const value of gates) value.resolve();
    await app.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (pathname, body) => fetch(base + pathname, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await request('/api/state')).json();
  const until = async (condition, message = 'authentication/sync did not settle') => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await state();
      if (condition(value)) { await app.store.queue; return state(); }
      await delay(10);
    }
    assert.fail(message);
  };
  const idle = () => until(value => !value.sync.running && value.sync.loginPlatforms.length === 0);
  return { app, calls, secrets, request, state, until, idle, gate, status: (id, patch) => options.onStatus(id, patch) };
}

test('saving credentials releases its lock, authenticates, and automatically syncs without deadlock', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/platforms/pta/credentials', { username: USER, password: PASSWORD })).status, 200);
  const state = await f.idle();
  assert.equal(f.calls.saved.length, 1); assert.deepEqual(f.calls.reset, ['pta']);
  assert.equal(f.calls.auth.length, 1); assert.deepEqual(f.calls.collect, ['pta']);
  assert.equal(state.assignments.length, 1);
  const platform = state.platforms.find(value => value.id === 'pta');
  assert.equal(platform.status, 'connected'); assert.equal(platform.loginStatus, 'authenticated');
  assert.ok(platform.lastSyncAt); assert.equal(state.sync.loginPlatforms.length, 0);
  const serialized = JSON.stringify(state);
  for (const secret of [USER, PASSWORD, VPN_PASSWORD]) assert.ok(!serialized.includes(secret));
});

test('credential login requires newly entered passwords and both Xiji account pairs', async t => {
  const f = await fixture(t);
  // A configured account must not make an empty password look like a new login.
  assert.equal((await f.request('/api/platforms/pta/credentials', { username: USER })).status, 400);
  assert.equal((await f.request('/api/platforms/xiji/credentials', { username: 'fixture-xiji', password: PASSWORD })).status, 400);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.auth.length, 0);

  assert.equal((await f.request('/api/platforms/xiji/credentials', {
    username: '  fixture-xiji  ', password: PASSWORD,
    vpnUsername: '  fixture-school  ', vpnPassword: VPN_PASSWORD,
  })).status, 200);
  const state = await f.idle();
  assert.deepEqual(f.calls.saved[0].value, {
    username: 'fixture-xiji', password: PASSWORD,
    vpnUsername: 'fixture-school', vpnPassword: VPN_PASSWORD,
  });
  assert.deepEqual(f.calls.auth.map(call => call.platform), ['xiji']);
  assert.deepEqual(f.calls.collect, ['xiji']);
  assert.equal(state.platforms.find(platform => platform.id === 'xiji').loginStatus, 'authenticated');
  assert.ok(!JSON.stringify(state).includes(PASSWORD));
  assert.ok(!JSON.stringify(state).includes(VPN_PASSWORD));
});

test('verify endpoint checks the existing session without password authentication or collection', async t => {
  const f = await fixture(t);
  await f.app.store.merge('pta', [oldItem], { complete: true });
  assert.equal((await f.request('/api/platforms/pta/verify', {})).status, 202);
  const state = await f.idle();
  assert.deepEqual(f.calls.verify, ['pta']); assert.equal(f.calls.auth.length, 0); assert.equal(f.calls.collect.length, 0);
  assert.equal(state.assignments[0].title, oldItem.title);
  assert.equal(state.platforms.find(value => value.id === 'pta').loginStatus, 'authenticated');
});

test('authenticate and login share the transaction; only login requests an interactive browser', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202); await f.idle();
  assert.equal((await f.request('/api/platforms/pta/login', {})).status, 202); await f.idle();
  assert.equal(f.calls.auth.length, 2); assert.equal(f.calls.auth[0].options.interactive, false); assert.equal(f.calls.auth[1].options.interactive, true);
  assert.deepEqual(f.calls.collect, ['pta', 'pta']);
});

test('authentication and synchronization exclude each other, including other platform jobs', async t => {
  let authGate, collectGate;
  const f = await fixture(t, {
    auth: async () => { await authGate.promise; return OK; },
    collect: async () => { await collectGate.promise; return { authenticated: true, complete: true, assignments: [] }; },
  });
  authGate = f.gate(); collectGate = f.gate();
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202);
  await f.until(state => state.sync.loginPlatforms.includes('pta'));
  for (const [url, body] of [['/api/sync', { platform: 'pta' }], ['/api/platforms/chaoxing/verify', {}], ['/api/platforms/pta/login', {}], ['/api/platforms/pta/credentials', { username: USER, password: PASSWORD }]]) assert.equal((await f.request(url, body)).status, 409);
  authGate.resolve(); await f.until(state => state.sync.running);
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 409);
  assert.equal((await f.request('/api/platforms/yuketang/verify', {})).status, 409);
  collectGate.resolve(); await f.idle();
  assert.equal((await f.request('/api/platforms/pta/verify', {})).status, 202); await f.idle();
});

test('valid authentication followed by partial collection is never reported complete', async t => {
  const f = await fixture(t, { collect: async () => ({ authenticated: true, complete: false, assignments: [newItem], message: '只读取了一门课。' }) });
  const previous = '2026-09-22T00:00:00.000Z';
  await f.app.store.merge('pta', [oldItem], { complete: true });
  await f.app.store.updatePlatform('pta', { status: 'connected', lastSyncAt: previous });
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202);
  const state = await f.idle(); const platform = state.platforms.find(value => value.id === 'pta');
  assert.equal(platform.loginStatus, 'authenticated'); assert.equal(platform.status, 'partial'); assert.equal(platform.lastSyncAt, previous);
  assert.equal(state.assignments.length, 2);
  assert.equal(state.assignments.find(value => value.title === oldItem.title).sourceMissing, false);
});

test('wrong password preserves previous assignments and releases authentication lock', async t => {
  const f = await fixture(t, { auth: async () => ({ authenticated: false, invalidCredentials: true, reason: '账号或密码错误。' }) });
  await f.app.store.merge('pta', [oldItem], { complete: true });
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202);
  const state = await f.idle();
  assert.equal(f.calls.collect.length, 0); assert.equal(state.assignments.length, 1); assert.equal(state.assignments[0].sourceMissing, false);
  const platform = state.platforms.find(value => value.id === 'pta');
  assert.equal(platform.loginStatus, 'invalid_credentials'); assert.equal(platform.status, 'auth_required');
  assert.equal((await f.request('/api/platforms/pta/verify', {})).status, 202); await f.idle();
});

test('explicit collector login failure triggers just one recovery and one re-collection', async t => {
  const f = await fixture(t, { collect: async (_, calls) => calls.collect.length === 1
    ? { authenticated: false, complete: false, assignments: [], message: '已跳转登录页。' }
    : { authenticated: true, complete: false, assignments: [newItem], message: '登录恢复，仅部分课程读取成功。' } });
  assert.equal((await f.request('/api/sync', { platform: 'pta' })).status, 202);
  const state = await f.idle();
  assert.equal(f.calls.auth.length, 1); assert.equal(f.calls.auth[0].options.navigate, true); assert.equal(f.calls.collect.length, 2);
  assert.equal(state.platforms.find(value => value.id === 'pta').status, 'partial');
  assert.equal(state.assignments.length, 1);
});

test('a second collector login failure never loops into repeated password recovery', async t => {
  const f = await fixture(t, { collect: async () => ({ authenticated: false, complete: false, assignments: [], message: '仍是登录页面。' }) });
  await f.app.store.merge('pta', [oldItem], { complete: true });
  assert.equal((await f.request('/api/sync', { platform: 'pta' })).status, 202);
  const state = await f.idle();
  assert.equal(f.calls.auth.length, 1); assert.equal(f.calls.collect.length, 2);
  assert.equal(state.platforms.find(value => value.id === 'pta').status, 'auth_required');
  assert.equal(state.assignments[0].sourceMissing, false);
});

test('unknown network failure and previously invalid credentials never trigger password recovery', async t => {
  for (const invalid of [false, true]) {
    const f = await fixture(t, { collect: async () => ({ authenticated: invalid ? false : null, complete: false, assignments: [], message: invalid ? '登录页' : '暂时网络异常' }) });
    if (invalid) await f.app.store.updatePlatform('pta', { loginStatus: 'invalid_credentials' });
    await f.app.store.merge('pta', [oldItem], { complete: true });
    assert.equal((await f.request('/api/sync', { platform: 'pta' })).status, 202);
    const state = await f.idle();
    assert.equal(f.calls.auth.length, 0); assert.equal(f.calls.collect.length, 1);
    assert.equal(state.assignments[0].sourceMissing, false);
  }
});

test('authentication exceptions release locks and do not echo thrown secrets', async t => {
  const f = await fixture(t, { auth: async () => { throw new Error(`connection error ${USER} ${PASSWORD}`); } });
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202);
  const state = await f.idle();
  assert.equal(f.calls.collect.length, 0); assert.equal(state.platforms.find(value => value.id === 'pta').loginStatus, 'unknown');
  assert.ok(!JSON.stringify(state).includes(PASSWORD));
  assert.equal((await f.request('/api/platforms/pta/verify', {})).status, 202); await f.idle();
});

test('credential storage failure releases the lock and leaves the old account intact', async t => {
  const f = await fixture(t, { save: async () => { throw new Error(`storage failed ${PASSWORD}`); } });
  const response = await f.request('/api/platforms/pta/credentials', { username: USER, password: PASSWORD });
  assert.equal(response.status, 400); assert.ok(!(await response.text()).includes(PASSWORD));
  const state = await f.idle(); assert.equal(state.sync.loginPlatforms.length, 0); assert.equal(f.calls.auth.length, 0);
  assert.equal(f.secrets.pta.password, PASSWORD);
  assert.equal((await f.request('/api/platforms/pta/verify', {})).status, 202); await f.idle();
});

test('both authentication reason channels are redacted before they reach API state', async t => {
  const f = await fixture(t, { auth: async () => ({ authenticated: false, invalidCredentials: true, reason: `拒绝登录 ${USER} ${PASSWORD} ${VPN_PASSWORD}` }) });
  assert.equal((await f.request('/api/platforms/pta/authenticate', {})).status, 202);
  const state = await f.idle(); const platform = state.platforms.find(value => value.id === 'pta');
  for (const secret of [USER, PASSWORD, VPN_PASSWORD]) {
    assert.ok(!platform.message.includes(secret), 'platform.message must redact every credential');
    assert.ok(!platform.authMessage.includes(secret), 'platform.authMessage must redact every credential');
    assert.ok(!JSON.stringify(state).includes(secret), 'GET /api/state must never contain stored credentials');
  }
});
