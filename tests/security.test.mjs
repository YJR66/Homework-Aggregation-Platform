import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { Store, exportIcs } from '../server/store.mjs';

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'homework-security-test-'));
}
async function removeTemporaryDirectory(dir) {
  const parent = path.resolve(os.tmpdir());
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), parent);
  assert.ok(path.basename(target).startsWith('homework-security-test-'));
  await rm(target, { recursive: true, force: true });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function appFixture({ openLogin = async () => {}, setCredentials } = {}) {
  const dir = await temporaryDirectory();
  const values = {};
  const vault = {
    get: id => values[id] || {},
    configured: id => Boolean(values[id]?.username && values[id]?.password),
    set: async (id, value) => { await setCredentials?.(id, value); values[id] = { ...values[id], ...value }; },
    redact: value => String(value),
  };
  const app = await createApplication({
    dataDir: dir, vault,
    browserFactory: () => ({
      browserAvailable: true, isOpen: () => false, openLogin, close: async () => {},
      getSession: async () => ({ page: { goto: async () => {} }, context: {} }),
    }),
    collector: async () => ({ authenticated: true, complete: true, assignments: [] }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = (url, method = 'GET', body, headers = {}) => fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, values, base, port, request, close: async () => { await app.close(); await removeTemporaryDirectory(dir); } };
}

test('store failed writes preserve committed memory/disk and remove temporary copies', async () => {
  const dir = await temporaryDirectory();
  try {
    const store = await new Store(dir).init();
    await store.merge('pta', [{ externalId: 'original', title: 'Committed fixture', status: 'submitted' }]);
    const filename = store.filename;
    const committed = structuredClone(store.data);
    const disk = await readFile(filename, 'utf8');
    const blocker = path.join(dir, 'not-a-file');
    await mkdir(blocker);
    store.filename = blocker;
    for (const mutate of [
      () => store.complete(committed.assignments[0].id, true),
      () => store.updatePlatform('pta', { status: 'connected', message: 'Uncommitted fixture' }),
      () => store.merge('pta', [{ externalId: 'failed-new', title: 'Uncommitted fixture' }]),
      () => store.updateSettings({ autoSync: false, syncIntervalMinutes: 45 }),
    ]) {
      await assert.rejects(mutate());
      assert.deepEqual(store.data, committed);
      assert.equal(await readFile(filename, 'utf8'), disk);
      assert.equal((await readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
    }
    assert.equal(await store.complete('missing-assignment', true), false);
    store.filename = filename;
    await store.updateSettings({ autoSync: false, syncIntervalMinutes: 15 });
    const recovered = await new Store(dir).init();
    assert.deepEqual(recovered.data.assignments, committed.assignments);
    assert.equal(recovered.platform('pta').status, committed.platforms.find(p => p.id === 'pta').status);
    assert.deepEqual(recovered.data.settings, { autoSync: false, syncIntervalMinutes: 15 });
  } finally { await removeTemporaryDirectory(dir); }
});

test('queued store mutations compose against the most recent committed snapshot', async () => {
  const dir = await temporaryDirectory();
  try {
    const store = await new Store(dir).init();
    await store.merge('pta', [{ externalId: 'one', title: 'Original fixture', status: 'submitted' }]);
    const id = store.data.assignments[0].id;
    const message = { message: 'Stable input snapshot' };
    const updates = [
      store.updateSettings({ autoSync: false, syncIntervalMinutes: 10 }),
      store.updatePlatform('pta', message),
      store.merge('chaoxing', [{ externalId: 'one', title: 'Separate platform fixture' }]),
      store.complete(id, true),
      store.persist(),
    ];
    message.message = 'Caller changed the input later';
    await Promise.all(updates);
    const disk = JSON.parse(await readFile(store.filename, 'utf8'));
    assert.deepEqual(store.data, disk);
    assert.equal(disk.assignments.length, 2);
    assert.notEqual(disk.assignments[0].id, disk.assignments[1].id);
    assert.equal(disk.assignments.find(item => item.id === id).completed, true);
    assert.equal(disk.platforms.find(platform => platform.id === 'pta').message, 'Stable input snapshot');
    assert.deepEqual(disk.settings, { autoSync: false, syncIntervalMinutes: 10 });
  } finally { await removeTemporaryDirectory(dir); }
});

test('calendar text cannot inject lines through bare carriage returns; invalid dates are skipped', () => {
  const base = { id: 'fixture', title: 'A\rBEGIN:INJECTED\r\nB', course: 'C', platform: 'pta', status: 'unknown', dueAt: '2026-09-25T00:00:00Z' };
  const calendar = exportIcs([base, { ...base, id: 'invalid', dueAt: 'invalid-date' }]);
  assert.equal((calendar.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(calendar.includes('SUMMARY:A\\nBEGIN:INJECTED\\nB'));
  assert.ok(!calendar.replaceAll('\r\n', '').includes('\r'));
});

test('HTTP rejects rebinding, cross-site requests, foreign origins, and non-JSON mutations', async () => {
  const fixture = await appFixture();
  try {
    // Fetch implementations may normalize Host; use raw HTTP for this boundary.
    const rebindingStatus = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: fixture.port, path: '/api/state', headers: { host: 'attacker.example' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
    });
    assert.equal(rebindingStatus, 403);
    assert.equal((await fixture.request('/api/state', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await fixture.request('/api/state', 'GET', undefined, { origin: 'null' })).status, 403);
    assert.equal((await fixture.request('/api/settings', 'PUT', { autoSync: false, syncIntervalMinutes: 5 }, { origin: 'http://127.0.0.1:65534' })).status, 403);
    assert.equal((await fixture.request('/api/settings', 'PUT', { autoSync: false, syncIntervalMinutes: 5 }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fixture.request('/api/settings', 'PUT', [])).status, 400);
    assert.equal((await fixture.request('/api/state')).status, 200);
    assert.equal((await fixture.request('/data/state.json')).status, 404);
  } finally { await fixture.close(); }
});

test('an active login job excludes simultaneous sync, login, and credential changes', async () => {
  const gate = deferred();
  const fixture = await appFixture({ openLogin: () => gate.promise });
  try {
    assert.equal((await fixture.request('/api/platforms/pta/login', 'POST', {})).status, 202);
    assert.equal((await fixture.request('/api/sync', 'POST', { platform: 'pta' })).status, 409);
    assert.equal((await fixture.request('/api/platforms/xiji/login', 'POST', {})).status, 409);
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'fixture-password' })).status, 409);
    gate.resolve();
    for (let count = 0; count < 100; count++) {
      if (!(await (await fixture.request('/api/state')).json()).sync.loginPlatforms.length) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'fixture-password' })).status, 200);
  } finally { gate.resolve(); await fixture.close(); }
});

test('JSON credentials remain valid when UTF-8 characters cross request chunk boundaries', async () => {
  const fixture = await appFixture();
  try {
    const credentials = { username: 'fixture-user', password: 'fake-汉字-password' };
    const bytes = Buffer.from(JSON.stringify(credentials));
    const split = bytes.indexOf(Buffer.from('汉')) + 1;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: fixture.port, path: '/api/platforms/pta/credentials', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.write(bytes.subarray(0, split));
      setTimeout(() => request.end(bytes.subarray(split)), 15);
    });
    assert.equal(status, 200);
    assert.deepEqual(fixture.values.pta, credentials);
  } finally { await fixture.close(); }
});

test('credential writes hold the operation lock and prevent switching into another account session', async () => {
  const gate = deferred();
  const entered = deferred();
  let holdFirstWrite = true;
  const fixture = await appFixture({ setCredentials: async () => {
    if (!holdFirstWrite) return;
    holdFirstWrite = false; entered.resolve(); await gate.promise;
  } });
  let save;
  try {
    save = fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'first-fake-password' });
    await entered.promise;
    assert.equal((await fixture.request('/api/platforms/pta/login', 'POST', {})).status, 409);
    assert.equal((await fixture.request('/api/sync', 'POST', { platform: 'pta' })).status, 409);
    assert.equal((await fixture.request('/api/platforms/xiji/credentials', 'POST', { username: 'another-fixture', password: 'fake-password' })).status, 409);
    gate.resolve();
    assert.equal((await save).status, 200);
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'different-account', password: 'different-fake-password' })).status, 409);
    assert.equal(fixture.values.pta.username, 'fixture-user');
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'new-fake-password' })).status, 200);
    assert.equal(fixture.values.pta.password, 'new-fake-password');
  } finally { gate.resolve(); await save; await fixture.close(); }
});

test('failed credential writes release the login/sync lock and do not announce a configured account', async () => {
  let fail = true;
  const fixture = await appFixture({ setCredentials: async () => { if (fail) throw new Error('Simulated storage failure'); } });
  try {
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'fake-password' })).status, 400);
    const state = await (await fixture.request('/api/state')).json();
    assert.equal(state.platforms.find(platform => platform.id === 'pta').configured, false);
    assert.equal(state.sync.loginPlatforms.length, 0);
    fail = false;
    assert.equal((await fixture.request('/api/platforms/pta/credentials', 'POST', { username: 'fixture-user', password: 'fake-password' })).status, 200);
  } finally { await fixture.close(); }
});
