import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { enrichPtaAssignment } from '../server/pta.mjs';

const assignment = { externalId: 'pta:123', url: 'https://pintia.cn/problem-sets/123/overview', title: 'PTA 限界测试' };
const complete = {
  exam: { status: 'PROCESSING', problemSet: { id: '123', problemSetConfig: { allowSubmitExam: false } }, exam: { id: '456', ended: false } },
  summary: { summaries: { PROGRAMMING: { total: 2 } } },
  problems: { problemStatus: [{ id: 'a', problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_ACCEPTED' }, { id: 'b', problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_NO_ANSWER' }] },
};

function fixture({ emitAttempt, body = '答题信息 答题中 1/2', timeout = 500 } = {}) {
  const page = new EventEmitter();
  const state = { navigations: [], active: 0 };
  page.goto = async url => {
    state.active++;
    state.navigations.push(url);
    await emitAttempt(page, state.active);
  };
  page.url = () => 'https://pintia.cn/problem-sets/123/exam/overview';
  page.locator = selector => { assert.equal(selector, 'body'); return { innerText: async () => body }; };
  page.waitForTimeout = async ms => { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 3))); };
  return { page, state, timeout };
}

function response(path, data, { delay = 0, hang = false } = {}) {
  return {
    url: () => `https://pintia.cn${path}`, status: () => 200,
    request: () => ({ method: () => 'GET' }),
    json: async () => {
      if (hang) await new Promise(() => {});
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return data;
    },
  };
}

async function emitSnapshot(page, snapshot, options = {}) {
  page.emit('response', response('/api/problem-sets/123/exams', snapshot.exam, options.exam));
  page.emit('response', response('/api/problem-sets/123/problem-summaries', snapshot.summary, options.summary));
  if (snapshot.problems) page.emit('response', response('/api/exams/456/problem-sets/123/problem-status', snapshot.problems, options.problems));
}

test('PTA waits for SPA native GET responses emitted after domcontentloaded', async () => {
  const timers = [];
  const fixtureData = fixture({ emitAttempt: async page => {
    timers.push(setTimeout(() => page.emit('response', response('/api/problem-sets/123/exams', complete.exam)), 40));
    timers.push(setTimeout(() => page.emit('response', response('/api/problem-sets/123/problem-summaries', complete.summary)), 80));
    timers.push(setTimeout(() => page.emit('response', response('/api/exams/456/problem-sets/123/problem-status', complete.problems)), 120));
  } });
  // A mocked browser delay must not cause a CPU spin that starves the events.
  fixtureData.page.waitForTimeout = async () => {};
  try {
    const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: 2000 });
    assert.equal(result.status, 'in_progress');
    assert.deepEqual(result.progress, { completed: 1, submitted: 1, total: 2, unit: '题' });
    assert.equal(fixtureData.state.active, 1);
    assert.equal(fixtureData.page.listenerCount('response'), 0);
  } finally { timers.forEach(clearTimeout); }
});

test('PTA READY needs only the personal exam response and rendered not-started evidence', async () => {
  let rendered = false;
  const timers = [];
  const fixtureData = fixture({ emitAttempt: async page => {
    timers.push(setTimeout(() => page.emit('response', response('/api/problem-sets/123/exams', {
      status: 'READY', problemSet: { id: '123' },
    })), 20));
    timers.push(setTimeout(() => { rendered = true; }, 60));
  } });
  fixtureData.page.locator = () => ({ innerText: async () => rendered ? '答题信息 未答题 开始答题' : '加载中' });
  fixtureData.page.waitForTimeout = async () => {};
  const start = Date.now();
  try {
    const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: 3000 });
    assert.equal(result.status, 'pending');
    assert.equal(result.detailComplete, true);
    assert.deepEqual(result.progress, { completed: 0, submitted: 0, total: null, unit: '题' });
    assert.equal(fixtureData.state.active, 1);
    assert.ok(Date.now() - start < 1000, 'READY must not wait for APIs the unopened exam never requests');
    assert.equal(fixtureData.page.listenerCount('response'), 0);
  } finally { timers.forEach(clearTimeout); }
});

test('PTA first navigation and SPA grace window preserve the second attempt budget', async () => {
  const fixtureData = fixture({ emitAttempt: async (page, attempt) => {
    if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 150));
    else await emitSnapshot(page, complete);
  } });
  const start = Date.now();
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: 1000 });
  assert.equal(result.status, 'in_progress');
  assert.equal(fixtureData.state.active, 2);
  assert.ok(Date.now() - start < 950, 'a missing first response must not exhaust the total retry budget');
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('PTA retries a missing read-only response once and succeeds without any button or private request', async () => {
  const fixtureData = fixture({ emitAttempt: async (page, attempt) => {
    if (attempt === 1) {
      // Exam and summary are present, but problem-status is temporarily absent.
      await emitSnapshot(page, { exam: complete.exam, summary: complete.summary });
    } else await emitSnapshot(page, complete);
  }, timeout: 3000 });
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  assert.equal(result.status, 'in_progress');
  assert.deepEqual(result.progress, { completed: 1, submitted: 1, total: 2, unit: '题' });
  assert.equal(fixtureData.state.active, 2);
  assert.deepEqual(fixtureData.state.navigations, [assignment.url, assignment.url]);
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('PTA response JSON timeout is bounded and a second clean GET can recover', async () => {
  const fixtureData = fixture({ emitAttempt: async (page, attempt) => {
    if (attempt === 1) {
      page.emit('response', response('/api/problem-sets/123/exams', complete.exam));
      page.emit('response', response('/api/problem-sets/123/problem-summaries', complete.summary));
      page.emit('response', response('/api/exams/456/problem-sets/123/problem-status', complete.problems, { hang: true }));
    } else await emitSnapshot(page, complete);
  }, timeout: 4000 });
  const start = Date.now();
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  assert.ok(Date.now() - start < 3500, 'a hanging response.json must not consume the entire process');
  assert.equal(result.status, 'in_progress');
  assert.equal(fixtureData.state.active, 2);
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('late JSON from an old attempt cannot contaminate the next isolated listener', async () => {
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const fixtureData = fixture({ emitAttempt: async (page, attempt) => {
    if (attempt === 1) {
      page.emit('response', response('/api/problem-sets/123/exams', complete.exam));
      page.emit('response', response('/api/problem-sets/123/problem-summaries', complete.summary));
      page.emit('response', { ...response('/api/exams/456/problem-sets/123/problem-status', complete.problems), json: async () => late });
    } else await emitSnapshot(page, complete);
  }, timeout: 3000 });
  const resultPromise = enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  await new Promise(resolve => setTimeout(resolve, 30));
  resolveLate({ problemStatus: [{ id: 'old', problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_ACCEPTED' }] });
  const result = await resultPromise;
  assert.equal(result.status, 'in_progress');
  assert.equal(result.progress.total, 2);
  assert.equal(fixtureData.state.active, 2);
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('unknown problem-status enum is deterministic and is never retried', async () => {
  const fixtureData = fixture({ emitAttempt: async page => await emitSnapshot(page, {
    exam: complete.exam, summary: complete.summary,
    problems: { problemStatus: [{ id: 'a', problemType: 'PROGRAMMING', problemSubmissionStatus: 'NEW_UNSUPPORTED_ENUM' }, { id: 'b', problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_NO_ANSWER' }] },
  }), timeout: 3000 });
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  assert.equal(result.status, 'unknown');
  assert.equal(fixtureData.state.active, 1);
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('incomplete coverage after both bounded read-only attempts stays unknown and does not click or submit', async () => {
  const fixtureData = fixture({ emitAttempt: async page => await emitSnapshot(page, {
    exam: complete.exam, summary: complete.summary,
    problems: { problemStatus: [{ id: 'a', problemType: 'PROGRAMMING', problemSubmissionStatus: 'PROBLEM_ACCEPTED' }] },
  }), timeout: 3000 });
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  assert.equal(result.status, 'unknown');
  assert.equal(fixtureData.state.active, 2);
  assert.equal(fixtureData.page.listenerCount('response'), 0);
});

test('only native GET response routes are accepted during resilience retries', async () => {
  let clicked = 0; let post = 0;
  const fixtureData = fixture({ emitAttempt: async page => {
    page.emit('response', { ...response('/api/problem-sets/123/exams', complete.exam), request: () => ({ method: () => 'POST' }) }); post++;
    page.emit('response', { ...response('/api/problem-sets/123/problem-summaries', complete.summary), request: () => ({ method: () => 'GET' }) });
    page.emit('response', { ...response('/api/exams/456/problem-sets/123/problem-status', complete.problems), request: () => ({ method: () => 'GET' }) });
  }, timeout: 1000 });
  fixtureData.page.click = async () => { clicked++; };
  const result = await enrichPtaAssignment(fixtureData.page, assignment, { timeoutMs: fixtureData.timeout });
  assert.equal(result.status, 'unknown');
  assert.equal(post, 2);
  assert.equal(clicked, 0);
  assert.equal(fixtureData.state.active, 2);
});
