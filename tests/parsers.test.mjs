import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDueAt, extractDeadline, parseStatus, normalizeAssignment, normalizePtaAssignment, stableExternalId, safeHttpUrl } from '../server/parsers.mjs';

const now = new Date('2026-09-21T16:00:00Z'); // 2026-09-22 00:00 Shanghai

test('Chinese date/time always uses Asia/Shanghai', () => {
  assert.equal(parseDueAt('2026年9月25日 23:30'), '2026-09-25T15:30:00.000Z');
  assert.equal(parseDueAt('2026-09-25 23:30:12'), '2026-09-25T15:30:12.000Z');
  assert.equal(parseDueAt('2026/9/25'), '2026-09-25T15:59:59.000Z');
  assert.equal(parseDueAt('2026-09-25T15:30:00Z'), '2026-09-25T15:30:00.000Z');
  assert.equal(parseDueAt('今天 18:00', { now }), '2026-09-22T10:00:00.000Z');
  assert.equal(parseDueAt('明天 18:00', { now }), '2026-09-23T10:00:00.000Z');
  assert.equal(parseDueAt('9月25日 12:00', { now }), '2026-09-25T04:00:00.000Z');
  assert.equal(parseDueAt('9月25日12:00', { now }), '2026-09-25T04:00:00.000Z');
});

test('unknown and invalid deadlines stay null', () => {
  for (const text of ['', '不限时', '未设置', '暂无数据', '2026-02-30', '2026-13-01', '2026-09-25 25:00', '2026-02-30T12:00:00Z']) assert.equal(parseDueAt(text), null, text);
  assert.equal(parseDueAt('开始 2026-09-20 10:00 至 2026-09-25 23:59'), '2026-09-25T15:59:00.000Z');
});

test('publication timestamp is never considered a deadline', () => {
  assert.equal(extractDeadline('第一章 发布于：2026-09-20 09:00 未提交'), '');
  assert.match(extractDeadline('发布时间：2026-09-20 09:00 截止时间：2026-09-25 23:59 未提交'), /^2026-09-25/);
});

test('submission status is distinct from an expired assignment', () => {
  const due = '2026-09-20T00:00:00Z';
  assert.equal(parseStatus('未提交', due, { now }), 'overdue');
  assert.equal(parseStatus('已提交 已截止', due, { now }), 'submitted');
  assert.equal(parseStatus('已截止', due, { now }), 'unknown');
  assert.equal(parseStatus('待批阅', due, { now }), 'submitted');
  assert.equal(parseStatus('已提交，退回重新提交', due, { now }), 'overdue');
  assert.equal(parseStatus('未完成', null, { now }), 'pending');
  assert.equal(parseStatus('总分：100', null, { now }), 'unknown');
});

test('normalization rejects navigation, course-only cards and public PTA catalogs', () => {
  const common = { text: '截止 2026-09-25 18:00 未提交', assignmentEvidence: true };
  assert.equal(normalizeAssignment({ ...common, title: '作业' }, { platform: 'chaoxing' }), null);
  assert.equal(normalizeAssignment({ title: '高等数学', text: '2026-09-25', assignmentEvidence: false }, { platform: 'chaoxing' }), null);
  assert.equal(normalizeAssignment({ ...common, title: '公开练习题', publicCatalog: true }, { platform: 'pta' }), null);
  const item = normalizeAssignment({ ...common, title: '第一章极限', course: '高等数学', url: 'https://i.chaoxing.com/work?workId=12' }, { platform: 'chaoxing', now });
  assert.equal(item.title, '第一章极限');
  assert.equal(item.dueAt, '2026-09-25T10:00:00.000Z');
  assert.equal(item.status, 'pending');
});

test('identities do not change with status, deadline or expiring signatures', () => {
  assert.equal(stableExternalId('xiji', { title: '实验一', course: 'C语言', dueAt: 'A' }), stableExternalId('xiji', { title: '实验一', course: 'C语言', dueAt: 'B' }));
  assert.equal(stableExternalId('pta', { url: 'https://pintia.cn/problem-sets/12?token=one' }), stableExternalId('pta', { url: 'https://pintia.cn/problem-sets/12?token=two' }));
  assert.notEqual(stableExternalId('xiji', { title: '实验一', course: 'C语言' }), stableExternalId('xiji', { title: '实验一', course: 'Java' }));
});

test('only HTTP links can be persisted', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)', 'https://pintia.cn/'), '');
  assert.equal(safeHttpUrl('/problem-sets/12', 'https://pintia.cn/'), 'https://pintia.cn/problem-sets/12');
});

test('verified PTA cards distinguish availability from submission and parse today-only closing time', () => {
  const card = { title: 'CPP-001-Hello', url: 'https://pintia.cn/problem-sets/123/overview', closeText: '17:30', availability: '已开放 已开考', personalList: true };
  const item = normalizePtaAssignment(card, { now });
  assert.equal(item.status, 'unknown');
  assert.equal(item.dueAt, '2026-09-22T09:30:00.000Z');
  assert.equal(item.externalId, 'pta:123');
  assert.equal(normalizePtaAssignment({ ...card, availability: '未开放' }, { now }), null);
  assert.equal(normalizePtaAssignment({ ...card, personalList: false }, { now }), null);
  assert.equal(normalizePtaAssignment({ ...card, url: 'https://pintia.cn/problem-sets/123/exam' }, { now }), null);
  assert.equal(normalizePtaAssignment({ ...card, closeText: '2026-12-27 23:59' }, { now }).dueAt, '2026-12-27T15:59:00.000Z');
});
