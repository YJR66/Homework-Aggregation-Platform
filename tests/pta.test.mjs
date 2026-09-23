import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ptaOverviewId, ptaResponseKind, normalizePtaDetail, enrichPtaAssignment } from '../server/pta.mjs';

const common = {
  problemSetId: '123', problemExamId: '456',
  exam: { problemSetId: '123', state: 'PROCESSING', examId: '456', allowSubmitExam: false, ended: false },
  summary: [{ total: 3 }],
  problems: [
    { id: 'a', status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' },
    { id: 'b', status: 'PROBLEM_NO_ANSWER', type: 'PROGRAMMING' },
    { id: 'c', status: 'PROBLEM_NO_ANSWER', type: 'PROGRAMMING' },
  ],
};

test('PTA permits only exact HTTPS read-only overview paths', () => {
  assert.equal(ptaOverviewId('https://pintia.cn/problem-sets/123/overview'), '123');
  assert.equal(ptaOverviewId('https://pintia.cn/problem-sets/123/exam/overview'), '123');
  for (const value of ['https://pintia.cn/problem-sets/123/exam/problems', 'https://pintia.cn/problem-sets/123/overview?start=1', 'http://pintia.cn/problem-sets/123/overview', 'https://pintia.cn.attacker.test/problem-sets/123/overview', 'https://user@pintia.cn/problem-sets/123/overview']) assert.equal(ptaOverviewId(value), null);
});

test('PTA native response whitelist excludes writes, other users and unrelated sets', () => {
  const url = 'https://pintia.cn/api/exams/456/problem-sets/123/problem-status';
  assert.deepEqual(ptaResponseKind(url, 'GET', '123'), { kind: 'problems', examId: '456' });
  assert.equal(ptaResponseKind(url, 'POST', '123'), null);
  assert.equal(ptaResponseKind(url, 'GET', '321'), null);
  assert.equal(ptaResponseKind(url + '?user=other', 'GET', '123'), null);
  assert.equal(ptaResponseKind('https://pintia.cn/api/exams/456/submissions', 'GET', '123'), null);
});

test('PTA partially submitted set stays actionable with exact counts', () => {
  const result = normalizePtaDetail(common);
  assert.equal(result.status, 'in_progress');
  assert.deepEqual(result.progress, { completed: 1, submitted: 1, total: 3, unit: '题' });
  assert.match(result.statusEvidence, /未提交 2 题/);
});

test('PTA objective submitted and programming accepted are distinct', () => {
  const result = normalizePtaDetail({ ...common, summary: [{ total: 9 }, { total: 10 }], problems: [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, status: 'PROBLEM_SUBMITTED', type: 'TRUE_OR_FALSE' })),
  ] });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.progress, { completed: 9, submitted: 19, total: 19, unit: '题' });
  assert.match(result.statusEvidence, /不代表全部答对/);
});

test('PTA wrong-answer rows are submitted but not accepted', () => {
  const result = normalizePtaDetail({ ...common, summary: [{ total: 3 }], problems: [
    { id: 'a', status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' },
    { id: 'b', status: 'PROBLEM_WRONG_ANSWER', type: 'TRUE_OR_FALSE' },
    { id: 'c', status: 'PROBLEM_ACCEPTED', type: 'TRUE_OR_FALSE' },
  ] });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.progress, { completed: 2, submitted: 3, total: 3, unit: '题' });
  assert.match(result.statusLabel, /1 题未通过/);
  assert.match(result.statusEvidence, /其中 1 题判题未通过/);
  assert.equal(result.detailComplete, true);
});

test('PTA wrong-answer plus unanswered rows remains actionable', () => {
  const result = normalizePtaDetail({ ...common, problems: [
    { id: 'a', status: 'PROBLEM_WRONG_ANSWER', type: 'PROGRAMMING' },
    { id: 'b', status: 'PROBLEM_NO_ANSWER', type: 'PROGRAMMING' },
    { id: 'c', status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' },
  ] });
  assert.equal(result.status, 'in_progress');
  assert.deepEqual(result.progress, { completed: 1, submitted: 2, total: 3, unit: '题' });
  assert.match(result.statusLabel, /已提交 2\/3 题/);
  assert.match(result.statusLabel, /1 题未通过/);
});

test('PTA ready without personal exam is explicitly not started, not ambiguous', () => {
  const result = normalizePtaDetail({ problemSetId: '123', exam: { problemSetId: '123', state: 'READY' }, body: '答题信息 未答题 开始答题' });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.progress, { completed: 0, submitted: 0, total: null, unit: '题' });
  assert.equal(normalizePtaDetail({ problemSetId: '123', exam: { problemSetId: '123', state: 'READY' }, body: '' }).status, 'unknown');
});

test('PTA answer progress cannot replace required final exam submission', () => {
  const result = normalizePtaDetail({ ...common, exam: { ...common.exam, allowSubmitExam: true }, problems: common.problems.map(row => ({ ...row, status: 'PROBLEM_ACCEPTED' })) });
  assert.equal(result.status, 'in_progress');
  assert.equal(result.statusLabel, '已答完 · 尚未交卷');
});

test('PTA wrong-answer enum is submitted but not passed', () => {
  const result = normalizePtaDetail({
    ...common,
    summary: [{ total: 9 }, { total: 1 }, { total: 9 }],
    problems: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `judge-${i}`, status: 'PROBLEM_ACCEPTED', type: 'TRUE_OR_FALSE' })),
      { id: 'judge-wrong', status: 'PROBLEM_WRONG_ANSWER', type: 'TRUE_OR_FALSE' },
      { id: 'cloze', status: 'PROBLEM_ACCEPTED', type: 'FILL_IN_THE_BLANK_FOR_PROGRAMMING' },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `code-${i}`, status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' })),
    ],
  });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.progress, { completed: 18, submitted: 19, total: 19, unit: '题' });
  assert.match(result.statusLabel, /1\s*题未通过/);
  assert.match(result.statusEvidence, /(?:判题未通过\s*1\s*题|1\s*题判题未通过)/);
  assert.equal(result.detailComplete, true);
});

test('PTA wrong-answer and no-answer remain distinguishable and actionable', () => {
  const result = normalizePtaDetail({
    ...common,
    problems: [
      { id: 'wrong', status: 'PROBLEM_WRONG_ANSWER', type: 'PROGRAMMING' },
      { id: 'empty', status: 'PROBLEM_NO_ANSWER', type: 'PROGRAMMING' },
      { id: 'ok', status: 'PROBLEM_ACCEPTED', type: 'PROGRAMMING' },
    ],
  });
  assert.equal(result.status, 'in_progress');
  assert.deepEqual(result.progress, { completed: 1, submitted: 2, total: 3, unit: '题' });
  assert.match(result.statusLabel, /已提交\s*2\/3/);
  assert.match(result.statusEvidence, /未提交\s*1\s*题/);
  assert.match(result.statusEvidence, /(?:判题未通过\s*1\s*题|1\s*题判题未通过)/);
  assert.equal(result.detailComplete, true);
});

test('PTA missing or duplicate rows never produce an invented completion', () => {
  for (const patch of [
    { problems: common.problems.slice(0, 1) },
    { problems: [common.problems[0], common.problems[0], common.problems[0]] },
    { summary: [] }, { summary: [{ total: '3' }] },
    { problemExamId: '999' }, { exam: { ...common.exam, problemSetId: '999' } },
    { problems: common.problems.map(row => ({ ...row, status: 'NEW_UNKNOWN_ENUM' })) },
  ]) assert.equal(normalizePtaDetail({ ...common, ...patch }).status, 'unknown');
});

test('PTA unknown status never becomes submitted and does not expose the raw server token', () => {
  const result = normalizePtaDetail({ ...common, problems: [
    { id: 'a', status: 'PROBLEM_JUDGE_TIMEOUT_SECRET_TOKEN', type: 'PROGRAMMING' },
    common.problems[1], common.problems[2],
  ] });
  assert.equal(result.status, 'unknown');
  assert.equal(result.detailComplete, false);
  assert.doesNotMatch(JSON.stringify(result), /PROBLEM_JUDGE_TIMEOUT_SECRET_TOKEN/);
});

test('PTA enrichment only navigates overview and consumes native read-only responses', async () => {
  const page = new EventEmitter();
  const navigations = [];
  page.goto = async url => {
    navigations.push(url);
    const emit = (path, data) => page.emit('response', { url: () => `https://pintia.cn${path}`, status: () => 200, request: () => ({ method: () => 'GET' }), json: async () => data });
    emit('/api/problem-sets/123/exams', { status: 'PROCESSING', problemSet: { id: '123', problemSetConfig: { allowSubmitExam: false } }, exam: { id: '456', ended: false, endAt: '2026-12-27T15:59:00Z' } });
    emit('/api/problem-sets/123/problem-summaries', { summaries: { PROGRAMMING: { total: 3 } } });
    emit('/api/exams/456/problem-sets/123/problem-status', { problemStatus: common.problems.map(row => ({ id: row.id, problemType: row.type, problemSubmissionStatus: row.status })) });
  };
  page.url = () => 'https://pintia.cn/problem-sets/123/exam/overview';
  page.locator = selector => { assert.equal(selector, 'body'); return { innerText: async () => '答题信息 答题中 1/3' }; };
  page.waitForTimeout = async () => {};
  const result = await enrichPtaAssignment(page, { externalId: 'pta:123', url: 'https://pintia.cn/problem-sets/123/overview', title: 'Fixture' });
  assert.equal(result.status, 'in_progress');
  assert.equal(result.dueAt, '2026-12-27T15:59:00.000Z');
  assert.equal(result.title, 'Fixture');
  assert.deepEqual(navigations, ['https://pintia.cn/problem-sets/123/overview']);
  assert.equal(page.listenerCount('response'), 0);
});

test('PTA enrichment accepts the observed 19-question CPP fixture and verifies full coverage', async () => {
  const page = new EventEmitter();
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `judge-${i}`, problemType: 'TRUE_OR_FALSE', problemSubmissionStatus: 'PROBLEM_ACCEPTED' })),
    { id: 'judge-wrong', problemType: 'TRUE_OR_FALSE', problemSubmissionStatus: 'PROBLEM_WRONG_ANSWER' },
    { id: 'cloze', problemType: 'FILL_IN_THE_BLANK_FOR_PROGRAMMING', problemSubmissionStatus: 'PROBLEM_ACCEPTED' },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `code-${i}`, problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_ACCEPTED' })),
  ];
  page.goto = async () => {
    const emit = (path, data) => page.emit('response', { url: () => `https://pintia.cn${path}`, status: () => 200, request: () => ({ method: () => 'GET' }), json: async () => data });
    emit('/api/problem-sets/123/exams', { status: 'PROCESSING', problemSet: { id: '123', endAt: '2026-09-24T09:30:00Z', problemSetConfig: { allowSubmitExam: false } }, exam: { id: '456', ended: false, score: 99 } });
    emit('/api/problem-sets/123/problem-summaries', { summaries: { TRUE_OR_FALSE: { total: 9 }, FILL_IN_THE_BLANK_FOR_PROGRAMMING: { total: 1 }, PROGRAMMING: { total: 9 } } });
    emit('/api/exams/456/problem-sets/123/problem-status', { problemStatus: rows });
  };
  page.url = () => 'https://pintia.cn/problem-sets/123/exam/overview';
  page.locator = () => ({ innerText: async () => '答题信息 答题中 19/19' });
  page.waitForTimeout = async () => {};
  const result = await enrichPtaAssignment(page, { externalId: 'pta:123', url: 'https://pintia.cn/problem-sets/123/overview', title: 'CPP-001-Hello' });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.progress, { completed: 18, submitted: 19, total: 19, unit: '题' });
  assert.equal(result.detailComplete, true);
  assert.match(result.statusEvidence, /(?:判题未通过\s*1\s*题|1\s*题判题未通过)/);
});

test('PTA mismatched item identity is rejected before any navigation', async () => {
  await assert.rejects(enrichPtaAssignment({}, { externalId: 'pta:999', url: 'https://pintia.cn/problem-sets/123/overview' }), /不属于/);
});
