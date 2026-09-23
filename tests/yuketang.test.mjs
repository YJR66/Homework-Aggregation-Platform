import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserManager } from '../server/browser.mjs';
import { collectYuketangAssignments, inspectYuketangCourses, isYuketangCourseUrl, normalizeYuketangTask, normalizeYuketangMaterialState, parseYuketangDeadline } from '../server/yuketang.mjs';

const now = new Date('2026-09-21T16:00:00.000Z');
const courseUrl = 'https://www.yuketang.cn/v2/web/studentLog/32510635?university_id=3013&platform_id=3&classroom_id=32510635&content_url=&tab=unfinished';
const base = { id: '90120162', title: '第一章作业下发', kind: '课件', course: '电工学', unfinishedScope: true, url: courseUrl, dueText: '01-31 23:59 截止 (132天后)', coursePeriod: '开课时间: 2026-08-20 00:00 至 2027-01-31 23:59' };

test('Yuketang course URLs only accept exact HTTPS student-list routes', () => {
  assert.equal(isYuketangCourseUrl(courseUrl), true);
  for (const url of ['https://www.yuketang.cn.evil.test/v2/web/studentLog/32510635', 'http://www.yuketang.cn/v2/web/studentLog/32510635', 'https://www.yuketang.cn/v2/web/exam/32510635', 'https://www.yuketang.cn/v2/web/studentLog/32510635/start', 'https://user:secret@www.yuketang.cn/v2/web/studentLog/32510635']) assert.equal(isYuketangCourseUrl(url), false);
});

test('short deadlines use relative timing to cross the year boundary correctly', () => {
  assert.equal(parseYuketangDeadline(base.dueText, { now }), '2027-01-31T15:59:00.000Z');
  assert.equal(parseYuketangDeadline('12-31 23:59 截止 (3天前)', { now: new Date('2027-01-03T00:00:00Z') }), '2026-12-31T15:59:00.000Z');
  assert.equal(parseYuketangDeadline('2027-01-31 23:59 截止', { now }), '2027-01-31T15:59:00.000Z');
  assert.equal(parseYuketangDeadline('01-31 23:59 截止', { now, coursePeriod: base.coursePeriod }), '2027-01-31T15:59:00.000Z');
  assert.equal(parseYuketangDeadline('01-31 23:59 截止', { now }), null);
  assert.equal(parseYuketangDeadline('无截止时间', { now }), null);
});

test('homework instructions in courseware are kept without inventing submission status', () => {
  const item = normalizeYuketangTask(base, { now });
  assert.equal(item.externalId, 'yuketang:32510635:90120162');
  assert.equal(item.title, '第一章作业下发');
  assert.equal(item.course, '电工学');
  assert.equal(item.dueAt, '2027-01-31T15:59:00.000Z');
  assert.equal(item.status, 'unknown');
  assert.equal(item.url, courseUrl);
});

test('courseware has precise personal page progress, not a fabricated written-submission state', () => {
  for (const [progress, status] of [['0/2页', 'pending'], ['1/2页', 'in_progress'], ['2/2页', 'completed']]) {
    const item = normalizeYuketangTask({ ...base, progress }, { now });
    assert.equal(item.status, status);
    assert.equal(item.kind, 'material');
    assert.equal(item.progress.total, 2);
    assert.equal(item.progress.unit, '页');
    assert.match(item.statusLabel, /课件/);
    assert.notEqual(item.status, 'submitted');
  }
  for (const progress of ['', '3/2页', '进行中', '0/0页']) assert.equal(normalizeYuketangTask({ ...base, progress }, { now }).status, 'unknown');
});

test('a material absent from unfinished is completed only with personal content-directory evidence', () => {
  const known = normalizeYuketangTask({ ...base, progress: '1/2页' }, { now });
  assert.equal(normalizeYuketangMaterialState(known, { title: known.title, progress: '已完成' }).status, 'completed');
  assert.deepEqual(normalizeYuketangMaterialState(known, { title: known.title, progress: '进行中(1/2)' }).progress, { completed: 1, total: 2, unit: '页' });
  assert.equal(normalizeYuketangMaterialState(known, { title: known.title, progress: '未开始' }).status, 'pending');
  assert.equal(normalizeYuketangMaterialState(known, { title: 'different', progress: '已完成' }), null);
  assert.equal(normalizeYuketangMaterialState(known, { title: known.title, progress: '' }), null);
});

test('only explicit written tasks or homework-related materials become assignments', () => {
  for (const patch of [
    { kind: '视频', title: '第一章讲解' }, { kind: '课件', title: '电路基础' },
    { kind: '公告', title: '作业通知' }, { kind: '课堂', title: '课堂签到' },
    { unfinishedScope: false }, { url: 'https://evil.test/' },
  ]) assert.equal(normalizeYuketangTask({ ...base, ...patch }, { now }), null);
  assert.equal(normalizeYuketangTask({ ...base, kind: '作业', title: '第一章练习' }, { now }).status, 'pending');
  assert.equal(normalizeYuketangTask({ ...base, kind: '试卷', title: '第一章测验', dueText: '09-20 23:59 截止 (2天前)' }, { now }).status, 'overdue');
});

test('task IDs remain distinct for different courses even if the platform reuses resource IDs', () => {
  const first = normalizeYuketangTask(base, { now });
  const second = normalizeYuketangTask({ ...base, url: courseUrl.replaceAll('32510635', '32511910'), course: '另一门课程' }, { now });
  assert.notEqual(first.externalId, second.externalId);
  assert.equal(normalizeYuketangTask({ ...base, url: courseUrl.replace('/32510635?', '/32510635/?') }, { now }).externalId, first.externalId);
});

function catalogFixture({ loginRequired = false, recover = false, networkFailure = false } = {}) {
  let navigations = 0;
  let closed = false;
  const tab = {
    async waitFor() {
      if (!recover || navigations < 2) {
        const error = new Error('Timeout waiting for SPA course tab');
        error.name = 'TimeoutError';
        throw error;
      }
    },
    async getAttribute() { return 'true'; },
  };
  const cards = {
    first: () => ({ waitFor: async () => {} }),
    last: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    count: async () => 0,
  };
  const worker = {
    setDefaultTimeout() {},
    async goto() {
      navigations++;
      if (networkFailure) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
      return null;
    },
    getByRole: () => tab,
    locator: () => cards,
    async evaluate() { return { authenticated: recover && navigations >= 2, studentSelected: true, courses: [], loginRequired }; },
    async waitForTimeout() {},
    isClosed: () => closed,
    async close() { closed = true; },
  };
  return { context: { newPage: async () => worker }, navigations: () => navigations, closed: () => closed };
}

test('Rain SPA failures remain unknown rather than falsely requiring login and retry only twice', async () => {
  const fixture = catalogFixture();
  const result = await collectYuketangAssignments({ platform: {}, context: fixture.context });
  assert.equal(result.authenticated, null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.assignments, []);
  assert.match(result.message, /自动重试/);
  assert.doesNotMatch(result.message, /重新连接|登录已失效/);
  assert.equal(fixture.navigations(), 2);
  assert.equal(fixture.closed(), true);
});

test('exhausted Rain navigation retries are not multiplied by the SPA retry loop', async () => {
  const fixture = catalogFixture({ networkFailure: true });
  const result = await collectYuketangAssignments({ platform: {}, context: fixture.context });
  assert.equal(result.authenticated, null);
  assert.equal(result.complete, false);
  assert.equal(fixture.navigations(), 3);
  assert.equal(fixture.closed(), true);
});

test('explicit login UI still requires reauthentication and does not repeatedly reload it', async () => {
  const fixture = catalogFixture({ loginRequired: true });
  const result = await collectYuketangAssignments({ platform: {}, context: fixture.context });
  assert.equal(result.authenticated, false);
  assert.equal(result.complete, false);
  assert.match(result.message, /重新连接账号/);
  assert.equal(fixture.navigations(), 1);
  assert.equal(fixture.closed(), true);
});

test('a transient SPA hydration failure recovers on the second catalog load', async () => {
  const fixture = catalogFixture({ recover: true });
  const result = await collectYuketangAssignments({ platform: {}, context: fixture.context });
  assert.equal(result.authenticated, true);
  assert.equal(fixture.navigations(), 2);
  assert.equal(fixture.closed(), true);
});

test('Rain authentication detection ignores blank pages and hidden login forms', async (t) => {
  const executablePath = new BrowserManager({ dataDir: './unused-test-profile' }).executablePath;
  if (!executablePath) return t.skip('本机未安装 Chromium 浏览器，跳过离线 DOM 集成测试');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>正在加载…</p><input style="display:none" type="password">');
    assert.equal((await inspectYuketangCourses(page)).loginRequired, false);
    await page.setContent('<input type="password"><button>登录</button>');
    assert.equal((await inspectYuketangCourses(page)).loginRequired, true);
    await page.setContent('<img alt="账号密码登录" width="40" height="40"><p>微信扫码登录</p>');
    assert.equal((await inspectYuketangCourses(page)).loginRequired, true);
    await page.setContent('<div id="tab-student" role="tab" aria-selected="true">我听的课</div><input hidden type="password">');
    assert.equal((await inspectYuketangCourses(page)).authenticated, true);
  } finally { await browser.close(); }
});

test('authenticated DOM integration traverses the student course and never opens the task', async (t) => {
  const executablePath = new BrowserManager({ dataDir: './unused-test-profile' }).executablePath;
  if (!executablePath) return t.skip('本机未安装 Chromium 浏览器，跳过离线 DOM 集成测试');
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  let forbiddenClicks = 0;
  let catalogRequests = 0;
  await context.exposeFunction('__forbidden', () => { forbiddenClicks++; });
  const homepage = `<div id="tab-student" role="tab" aria-selected="true">我听的课</div>
    <div id="pane-student"><div class="el-card"><h1 onclick="location.href='${courseUrl}'">电工学</h1><span class="className">2026秋-机械2502</span></div></div>
    <button onclick="__forbidden()">加入班级</button>`;
  const contentUrl = courseUrl.replace('tab=unfinished', 'tab=content');
  const frameUrl = 'https://www.yuketang.cn/pro/lms/observed/32510635/studycontent';
  const course = `<p>开课时间: 2026-08-20 00:00 至 2027-01-31 23:59</p><button>未完成</button><button onclick="location.href='${contentUrl}'">学习内容</button>
    <div class="unfinished-study"><button class="unfinished-study__range-tab unfinished-study__range-tab--active"><span class="unfinished-study__range-icon"></span> <span class="unfinished-study__range-label">全部待办</span> <span class="unfinished-study__range-count">1</span></button>
    <button class="unfinished-study__timeout-tab unfinished-study__timeout-tab--active">全部 (1)</button>
    <button class="unfinished-study__type-tab unfinished-study__type-tab--active">全部 (1)</button>
    <label class="unfinished-study__score-checkbox"><input type="checkbox">仅计分</label>
    <ul><li class="unfinished-study__item"><span class="unfinished-study__type-text">课件</span><div class="unfinished-study__item-title" data-title-key="90120162">第一章作业下发</div><div class="unfinished-study__item-status">1/2页</div><div class="unfinished-study__item-time">01-31 23:59 截止 (132天后)</div><button aria-label="去完成" onclick="__forbidden()">去完成</button></li></ul></div>`;
  await context.route('**/*', (route) => {
    if (route.request().url() === frameUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="leaf-detail" onclick="__forbidden()"><div class="leaf-title"><i class="icon--Hkejian2"></i><span class="title">上次未读完的作业课件</span></div><div class="progress-wrap">已完成</div></div>' });
    if (route.request().url() === contentUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<iframe src="${frameUrl}"></iframe>` });
    const isCourse = isYuketangCourseUrl(route.request().url());
    if (!isCourse && ++catalogRequests === 1) return route.abort('internetdisconnected');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: isCourse ? course : homepage });
  });
  try {
    const page = await context.newPage();
    const known = normalizeYuketangTask({ ...base, id: 'older-material', title: '上次未读完的作业课件', progress: '1/2页' }, { now });
    const result = await collectYuketangAssignments({ platform: { id: 'yuketang', name: '雨课堂' }, context, page, knownAssignments: [known] });
    assert.equal(result.authenticated, true);
    assert.equal(result.complete, true, result.message);
    assert.equal(result.assignments.length, 2);
    assert.equal(result.assignments[0].status, 'in_progress');
    assert.deepEqual(result.assignments[0].progress, { completed: 1, total: 2, unit: '页' });
    assert.equal(result.assignments[1].externalId, known.externalId);
    assert.equal(result.assignments[1].status, 'completed');
    assert.deepEqual(result.assignments[1].progress, { completed: 2, total: 2, unit: '页' });
    assert.equal(result.diagnostics.courses[0].total, 1);
    assert.equal(forbiddenClicks, 0);
    assert.ok(catalogRequests >= 3, 'initial network failure must recover before collecting course tasks');
    assert.equal(context.pages().length, 1, 'worker must close without closing the caller page');
  } finally { await browser.close(); }
});
