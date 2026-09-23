import test from 'node:test';
import assert from 'node:assert/strict';
import { chaoxingUrl, parseChaoxingCountdown, normalizeChaoxingWork, verifyChaoxingWorkCoverage } from '../server/chaoxing.mjs';

const now = new Date('2026-09-21T16:21:43.500Z');
const course = { title: '理论力学', courseId: '123', classId: '456', closed: false };
const record = { title: '作业20260918', statusText: '未交', timeText: '剩余31小时39分钟', url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=123&classId=456&workId=789&enc=ephemeral' };

test('Chaoxing countdown estimate rounds observation to minutes', () => {
  assert.equal(parseChaoxingCountdown('剩余31小时39分钟', { now }), '2026-09-23T00:00:00.000Z');
  assert.equal(parseChaoxingCountdown('剩余1天2小时5分钟', { now }), '2026-09-22T18:26:00.000Z');
  assert.equal(parseChaoxingCountdown('已截止', { now }), null);
  assert.equal(parseChaoxingCountdown('2026-09-23 08:00', { now }), null);
});

test('Chaoxing work preserves known submission states and estimated deadlines', () => {
  const item = normalizeChaoxingWork(record, course, { now });
  assert.equal(item.status, 'pending');
  assert.equal(item.dueAt, '2026-09-23T00:00:00.000Z');
  assert.equal(item.dueAtEstimated, true);
  assert.equal(item.dueText, '剩余31小时39分钟');
  assert.equal(item.externalId, 'chaoxing:123:456:789');
  for (const statusText of ['已完成', '待批阅', '已提交']) assert.equal(normalizeChaoxingWork({ ...record, statusText, timeText: '' }, course, { now }).status, 'submitted');
  assert.equal(normalizeChaoxingWork({ ...record, timeText: '已截止' }, course, { now }).status, 'overdue');
  assert.equal(normalizeChaoxingWork({ ...record, timeText: '截止时间：2026-09-23 08:00' }, course, { now }).dueAtEstimated, false);
});

test('closed courses, unknown links and untrusted hosts never become assignments', () => {
  assert.equal(normalizeChaoxingWork(record, { ...course, closed: true }, { now }), null);
  assert.equal(normalizeChaoxingWork({ ...record, url: 'https://mooc1.chaoxing.com/exam/123' }, course, { now }), null);
  assert.equal(chaoxingUrl('https://chaoxing.com.attacker.test/work/task?workId=123'), '');
  assert.equal(chaoxingUrl('http://mooc1.chaoxing.com/work/task?workId=123'), '');
});

test('coverage requires the all filter, unique work count and no rejected rows', () => {
  assert.equal(verifyChaoxingWorkCoverage({ total: 5, seen: 5, allFilter: true }), true);
  assert.equal(verifyChaoxingWorkCoverage({ total: 0, seen: 0, allFilter: true }), true);
  assert.equal(verifyChaoxingWorkCoverage({ total: 5, seen: 4, allFilter: true }), false);
  assert.equal(verifyChaoxingWorkCoverage({ total: 5, seen: 5, allFilter: false }), false);
  assert.equal(verifyChaoxingWorkCoverage({ total: null, seen: 0, allFilter: true }), false);
  assert.equal(verifyChaoxingWorkCoverage({ total: 5, seen: 5, allFilter: true, invalidRows: 1 }), false);
});
