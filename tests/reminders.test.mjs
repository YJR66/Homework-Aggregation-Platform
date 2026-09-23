import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderMessage, dueReminderEvents, normalizeEmailSettings } from '../server/reminders.mjs';

const HOUR = 3_600_000;
const start = Date.parse('2026-09-23T10:00:00.000Z');
const config = (overrides = {}) => ({
  enabled: true, host: 'smtp.example.com', port: 465, secure: true,
  username: 'sender@example.com', from: 'sender@example.com', to: 'user@example.com',
  freshnessMinutes: 120,
  rules: [{ id: 'one-hour', kind: 'before', minutes: 60, platform: 'all' }],
  ...overrides,
});
const task = (overrides = {}) => ({
  id: 'task-1', platform: 'pta', title: '测试作业', course: '测试课程',
  dueAt: new Date(start + 2 * HOUR).toISOString(),
  lastSeenAt: new Date(start).toISOString(), status: 'pending', sourceMissing: false,
  ...overrides,
});

test('email settings validate addresses, deadlines and rule activation without accepting caller timestamps', () => {
  const first = normalizeEmailSettings(config(), undefined, start);
  assert.equal(first.rules[0].effectiveFrom, new Date(start).toISOString());
  assert.equal('password' in first, false);
  const unchanged = normalizeEmailSettings(config(), first, start + HOUR);
  assert.equal(unchanged.rules[0].effectiveFrom, first.rules[0].effectiveFrom);
  const edited = normalizeEmailSettings(config({ rules: [{ ...first.rules[0], minutes: 30, effectiveFrom: '2000-01-01' }] }), first, start + HOUR);
  assert.equal(edited.rules[0].effectiveFrom, new Date(start + HOUR).toISOString());
  const disabled = normalizeEmailSettings(config({ enabled: false }), first, start + HOUR);
  const reenabled = normalizeEmailSettings(config(), disabled, start + 2 * HOUR);
  assert.equal(reenabled.rules[0].effectiveFrom, new Date(start + 2 * HOUR).toISOString());
  for (const invalid of [
    config({ to: 'user@example.com\r\nBcc: attacker@example.com' }),
    config({ host: 'https://smtp.example.com/path' }),
    config({ port: 0 }),
    config({ rules: [] }),
    config({ rules: [config().rules[0], { ...config().rules[0], id: 'duplicate' }] }),
    config({ rules: [{ id: 'bad', kind: 'after', minutes: -1, platform: 'all' }] }),
  ]) assert.throws(() => normalizeEmailSettings(invalid, undefined, start));
});

test('reminders require a fresh and explicitly unfinished cloud state', () => {
  const settings = normalizeEmailSettings(config(), undefined, start);
  const at = start + HOUR + 1000;
  const current = task();
  assert.equal(dueReminderEvents([current], settings, {}, at).length, 1);
  for (const excluded of [
    task({ status: 'submitted' }), task({ status: 'completed' }), task({ status: 'unknown' }),
    task({ sourceMissing: true }), task({ dueAt: null }),
    task({ lastSeenAt: new Date(start - 2 * HOUR).toISOString() }),
  ]) assert.equal(dueReminderEvents([excluded], settings, {}, at).length, 0);
  assert.equal(dueReminderEvents([current], settings, {}, start + 30 * 60_000).length, 0);
  assert.equal(dueReminderEvents([current], settings, {}, start + 2 * HOUR).length, 0);
  const event = dueReminderEvents([current], settings, {}, at)[0];
  assert.equal(dueReminderEvents([current], settings, { [event.key]: new Date(at).toISOString() }, at).length, 0);
  assert.notEqual(dueReminderEvents([task({ dueAt: new Date(start + 3 * HOUR).toISOString(),
    lastSeenAt: new Date(at + HOUR).toISOString() })], settings, {}, at + HOUR)[0].key, event.key);
});

test('platform filters, overdue rules and first-activation boundaries are respected', () => {
  const settings = normalizeEmailSettings(config({ rules: [
    { id: 'pta-only', kind: 'before', minutes: 60, platform: 'pta' },
    { id: 'overdue', kind: 'after', minutes: 0, platform: 'all' },
  ] }), undefined, start);
  assert.equal(dueReminderEvents([task({ platform: 'xiji' })], settings, {}, start + HOUR).length, 0);
  assert.equal(dueReminderEvents([task()], settings, {}, start + HOUR).length, 1);
  const after = dueReminderEvents([task({ lastSeenAt: new Date(start + 2 * HOUR).toISOString() })], settings, {}, start + 2 * HOUR);
  assert.equal(after.length, 1);
  assert.equal(after[0].rule.kind, 'after');
  const lateRule = normalizeEmailSettings(config(), undefined, start + HOUR + 1000);
  assert.equal(dueReminderEvents([task()], lateRule, {}, start + HOUR + 2000).length, 0);
});

test('email text omits signed platform URLs and labels estimated deadlines', () => {
  const settings = normalizeEmailSettings(config(), undefined, start);
  const assignment = task({ url: 'https://example.com/task?enc=sensitive-token', dueAtEstimated: true, statusLabel: '未提交' });
  const message = buildReminderMessage(dueReminderEvents([assignment], settings, {}, start + HOUR));
  assert.match(message.subject, /1 项作业/);
  assert.match(message.text, /PTA.*测试作业/);
  assert.match(message.text, /截止前 1 小时/);
  assert.match(message.text, /约 /);
  assert.doesNotMatch(message.text, /sensitive-token|https:\/\//);
});
