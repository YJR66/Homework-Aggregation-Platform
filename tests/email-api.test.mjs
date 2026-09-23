import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

const HOUR = 3_600_000;
const PASSWORD = 'fixture-smtp-secret-never-echo';
const settings = (overrides = {}) => ({
  enabled: true, host: 'smtp.example.com', port: 465, secure: true,
  username: 'sender@example.com', from: 'sender@example.com', to: 'receiver@example.com',
  freshnessMinutes: 720,
  rules: [{ id: 'one-hour', kind: 'before', minutes: 60, platform: 'all' }],
  ...overrides,
});

async function fixture(t, send = async () => ({})) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-email-'));
  const secrets = {};
  let time = Date.now();
  const calls = [];
  const vault = {
    get: id => secrets[id] || {},
    configured: id => Boolean(secrets[id]?.username && secrets[id]?.password),
    set: async (id, value) => { secrets[id] = { ...secrets[id], ...value }; },
    redact: value => String(value || '').replaceAll(PASSWORD, '[已隐藏]'),
  };
  const app = await createApplication({ dataDir: dir, vault, now: () => time,
    browserFactory: () => ({ browserAvailable: true, ocrAvailable: false, isOpen: () => false, close: async () => {} }),
    mailSender: async (config, password, message) => {
      calls.push({ config, password, message });
      return send(config, password, message);
    },
  });
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, dir, calls, request, get time() { return time; }, set time(value) { time = value; } };
}

test('SMTP credentials stay out of API state; an unfinished task sends once and survives restart', async t => {
  const f = await fixture(t);
  const saved = await f.request('/api/email-settings', 'PUT', { ...settings(), password: PASSWORD });
  assert.equal(saved.status, 200);
  const state = (await f.request('/api/state')).body;
  assert.equal(state.emailSettings.passwordConfigured, true);
  assert.equal(state.emailSettings.rules.length, 1);
  assert.equal('emailSent' in state, false);
  assert.ok(!JSON.stringify(state).includes(PASSWORD));

  await f.app.store.merge('pta', [{ externalId: 'a', title: '未完成作业', course: '测试课',
    dueAt: new Date(f.time + 2 * HOUR).toISOString(), status: 'pending',
    url: 'https://pintia.cn/problem-sets/1/overview?token=sensitive' }], { complete: true });
  f.time += HOUR + 1000;
  assert.equal(await f.app.checkEmailReminders(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].password, PASSWORD);
  assert.equal(f.calls[0].config.to, 'receiver@example.com');
  assert.match(f.calls[0].message.text, /未完成作业/);
  assert.doesNotMatch(f.calls[0].message.text, /sensitive|https:/);
  assert.equal(await f.app.checkEmailReminders(), false);
  assert.equal(f.calls.length, 1);
  const reloaded = await new Store(f.dir).init();
  assert.equal(Object.keys(reloaded.data.emailSent).length, 1);
  assert.equal(reloaded.data.emailSettings.lastError, '');
  assert.ok(reloaded.data.emailSettings.lastSentAt);

  // A confirmed platform completion prevents any later rule from sending.
  await f.app.store.merge('pta', [{ externalId: 'a', title: '未完成作业', course: '测试课',
    dueAt: new Date(f.time + HOUR).toISOString(), status: 'submitted' }], { complete: true });
  assert.equal(await f.app.checkEmailReminders(), false);
});

test('SMTP settings reject invalid destinations and require a password when enabled', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/email-settings', 'PUT', settings())).status, 400);
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings(), to: 'receiver@example.com\r\nBcc: x@example.com', password: PASSWORD })).status, 400);
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings(), host: 'http://evil.example', password: PASSWORD })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings(), password: PASSWORD })).status, 200);
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings({ username: 'changed@example.com' }) })).status, 400);
  assert.equal((await f.request('/api/email-settings', 'PUT', settings())).status, 200);
});

test('test email uses only the saved recipient, reports success and never consumes reminder keys', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/email-test', 'POST', {})).status, 400);
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings({ enabled: false }), password: PASSWORD })).status, 200);
  const response = await f.request('/api/email-test', 'POST', { to: 'different@example.com' });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].config.to, 'receiver@example.com');
  assert.match(f.calls[0].message.subject, /测试邮件/);
  assert.equal(Object.keys(f.app.store.data.emailSent).length, 0);
  assert.ok(f.app.store.data.emailSettings.lastTestAt);
});

test('failed SMTP delivery is not marked sent and is retried after recovery', async t => {
  let fail = true;
  const f = await fixture(t, async () => { if (fail) throw new Error(`secret: ${PASSWORD}`); return {}; });
  assert.equal((await f.request('/api/email-settings', 'PUT', { ...settings(), password: PASSWORD })).status, 200);
  await f.app.store.merge('pta', [{ externalId: 'b', title: '重试作业', course: '测试课',
    dueAt: new Date(f.time + 2 * HOUR).toISOString(), status: 'pending' }]);
  f.time += HOUR;
  assert.equal(await f.app.checkEmailReminders(), false);
  assert.equal(Object.keys(f.app.store.data.emailSent).length, 0);
  const state = (await f.request('/api/state')).body;
  assert.match(state.emailSettings.lastError, /发送失败/);
  assert.ok(!JSON.stringify(state).includes(PASSWORD));
  fail = false;
  assert.equal(await f.app.checkEmailReminders(), true);
  assert.equal(f.calls.length, 2);
  assert.equal(Object.keys(f.app.store.data.emailSent).length, 1);
});
