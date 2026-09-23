import { cleanText, normalizeAssignment, parseDueAt } from './parsers.mjs';
import { gotoReadOnly } from './navigation.mjs';

// Observed in the authenticated Rain Classroom v2 student UI (2026-09-22).
// Only course navigation and read-only unfinished lists are used. We never click
// “去完成”, open a resource (which can record progress), or begin an examination.
const HOME = 'https://www.yuketang.cn/v2/web/index';
const ROOT = '.unfinished-study';
const CARD = '#pane-student .el-card';
const DAY = 86_400_000;

// Materials use reading progress, not the homework submission vocabulary.
function materialProgressState(completed, total) {
  return {
    status: completed === total ? 'completed' : completed > 0 ? 'in_progress' : 'pending',
    statusLabel: completed === total ? `课件已读完 ${completed}/${total} 页`
      : completed > 0 ? `课件阅读中 ${completed}/${total} 页` : `课件未开始 0/${total} 页`,
  };
}

export function isYuketangCourseUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.yuketang.cn' && !url.username && !url.password
      && /^\/v2\/web\/studentLog\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** The UI omits the year, including for a January deadline in the next year. */
export function parseYuketangDeadline(value, { now = new Date(), coursePeriod = '' } = {}) {
  const text = cleanText(value);
  if (!text || /无截止|不限时|长期有效/.test(text)) return null;
  if (/20\d{2}[-/年]/.test(text)) return parseDueAt(text, { now });
  const short = text.match(/(?:^|\s)(\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2})[:：](\d{2})/);
  if (!short) return parseDueAt(text, { now });
  const instant = new Date(now).getTime();
  const shanghai = new Date(instant + 8 * 3_600_000);
  const year = shanghai.getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => parseDueAt(`${y}-${short[1]}-${short[2]} ${short[3]}:${short[4]}`, { now })).filter(Boolean);
  const relative = text.match(/(\d+)\s*天(后|前)/);
  if (relative) {
    const target = instant + Number(relative[1]) * (relative[2] === '前' ? -DAY : DAY);
    return candidates.sort((a, b) => Math.abs(Date.parse(a) - target) - Math.abs(Date.parse(b) - target))[0] || null;
  }
  const bounds = [...String(coursePeriod).matchAll(/20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}/g)].map((match) => parseDueAt(match[0], { now })).filter(Boolean);
  if (bounds.length >= 2) {
    const bounded = candidates.filter((candidate) => Date.parse(candidate) >= Date.parse(bounds[0]) && Date.parse(candidate) <= Date.parse(bounds[1]));
    if (bounded.length === 1) return bounded[0];
  }
  // Without relative/term evidence there is no defensible way to pick a year.
  // Preserve an unknown deadline rather than inventing a year or false overdue.
  return null;
}

export function normalizeYuketangTask(record, { now = new Date() } = {}) {
  if (!record?.unfinishedScope || !isYuketangCourseUrl(record.url)) return null;
  const kind = cleanText(record.kind);
  const title = cleanText(record.title);
  const writtenType = /^(?:作业|试卷|练习|测验|测试|考试|习题|习题集)$/.test(kind);
  const homeworkMaterial = /作业|习题|练习题/.test(title) && /^(?:课件|资料|文档)$/.test(kind);
  if (!writtenType && !homeworkMaterial) return null;
  const item = normalizeAssignment({
    ...record,
    id: record.id ? `${new URL(record.url).pathname.split('/').filter(Boolean).at(-1)}:${record.id}` : undefined,
    statusText: writtenType ? '未完成' : '',
    dueText: '',
    assignmentEvidence: true, explicitAssignment: true,
  }, { platform: 'yuketang', course: record.course, now });
  if (!item) return null;
  item.dueAt = parseYuketangDeadline(record.dueText, { now, coursePeriod: record.coursePeriod });
  item.kind = homeworkMaterial ? 'material' : 'assignment';
  if (homeworkMaterial) {
    const count = cleanText(record.progress).match(/^(\d+)\s*\/\s*(\d+)\s*页?$/);
    if (count && Number(count[2]) > 0 && Number(count[1]) <= Number(count[2])) {
      const completed = Number(count[1]), total = Number(count[2]);
      item.progress = { completed, total, unit: '页' };
      Object.assign(item, materialProgressState(completed, total));
      item.statusEvidence = `雨课堂「${kind}」阅读进度 ${completed}/${total} 页；阅读进度不等于作业提交。`;
    } else {
      item.status = 'unknown';
      item.statusLabel = '课件阅读进度读取失败';
      item.statusEvidence = '作业相关课件的个人阅读页数未读到，完成状态待确认。';
    }
  } else {
    item.status = item.dueAt && Date.parse(item.dueAt) < new Date(now).getTime() ? 'overdue' : 'pending';
    item.statusLabel = '作业未完成';
    item.statusEvidence = `雨课堂「未完成」列表中的${kind}任务${record.progress ? `，平台显示「${cleanText(record.progress)}」` : ''}。`;
  }
  return item;
}

export async function inspectYuketangCourses(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean(el?.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const tab = document.querySelector('#tab-student');
    // A missing SPA tab is not evidence of an expired session: the bundle or
    // course API may still be loading after a network change. Require visible
    // login controls before asking the user to authenticate again.
    const loginRequired = [...document.querySelectorAll('input[type="password"], img[alt="账号密码登录"], .login-btn')]
      .some((el) => visible(el) && (el.matches('input, img') || /^登\s*录$/.test(text(el))))
      || [...document.querySelectorAll('button,a,span,p,div')].some((el) => visible(el) && el.children.length === 0
        && /^(?:请先登录|登录已过期|会话已过期|请重新登录|扫码登录|微信扫码登录|请使用微信扫码登录)$/.test(text(el)));
    const loading = [...document.querySelectorAll('#pane-student .el-loading-mask,[aria-busy="true"]')].some(visible);
    const loadError = [...document.querySelectorAll('.el-message--error,.el-notification.error,[role="alert"]')]
      .some((el) => visible(el) && /错误|失败|异常|error/i.test(text(el)));
    const cards = [...document.querySelectorAll('#pane-student .el-card')].filter(visible);
    const courses = cards.map((card, index) => ({ index, title: text(card.querySelector('h1')), className: text(card.querySelector('.className')) })).filter((course) => course.title);
    const next = [...document.querySelectorAll('#pane-student button, #pane-student a')].find((el) => visible(el) && /^(?:下一页|加载更多)$/.test(text(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    return { url: location.href, authenticated: visible(tab) && !loginRequired, loginRequired, loading, loadError,
      studentSelected: tab?.getAttribute('aria-selected') === 'true', courses, hasMore: Boolean(next) };
  });
}

export async function inspectYuketangUnfinished(page, course = '') {
  return page.evaluate(({ course }) => {
    const visible = (el) => Boolean(el?.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('.unfinished-study');
    if (!root || !visible(root)) return { ready: false, records: [] };
    const range = [...root.querySelectorAll('.unfinished-study__range-tab')].find((el) => text(el.querySelector('.unfinished-study__range-label')) === '全部待办');
    const countText = text(range?.querySelector('.unfinished-study__range-count'));
    const total = /^\d+$/.test(countText) ? Number(countText) : null;
    const bodyText = document.body.innerText;
    const coursePeriod = bodyText.match(/开课时间\s*[:：]?[^\n]+/)?.[0] || '';
    const records = [...root.querySelectorAll('.unfinished-study__item')].filter(visible).map((row) => ({
      id: row.querySelector('[data-title-key]')?.getAttribute('data-title-key') || '',
      title: text(row.querySelector('.unfinished-study__item-title')),
      kind: text(row.querySelector('.unfinished-study__type-text')),
      dueText: text(row.querySelector('.unfinished-study__item-time')),
      progress: text(row.querySelector('.unfinished-study__item-status')),
      text: text(row), course, coursePeriod,
      url: location.href, unfinishedScope: true,
    }));
    const loading = [...root.querySelectorAll('.el-loading-mask,.rain-loading,[aria-busy="true"]')].some(visible);
    const loadError = [...document.querySelectorAll('.el-message--error,.el-notification.error,[role="alert"]')].some((el) => visible(el) && /错误|失败|异常|error/i.test(text(el)));
    const next = [...root.querySelectorAll('.el-pagination .btn-next, button[aria-label="下一页"], button[title="下一页"]')].find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const allTimeouts = [...root.querySelectorAll('.unfinished-study__timeout-tab')].find((el) => /^全部/.test(text(el)));
    const allTypes = [...root.querySelectorAll('.unfinished-study__type-tab')].find((el) => /^全部/.test(text(el)));
    const filtersAll = Boolean(range?.classList.contains('unfinished-study__range-tab--active'))
      && Boolean(allTimeouts?.classList.contains('unfinished-study__timeout-tab--active'))
      && Boolean(allTypes?.classList.contains('unfinished-study__type-tab--active'))
      && !root.querySelector('.unfinished-study__score-checkbox input')?.checked;
    return { ready: !loading && !loadError, url: location.href, total, records, filtersAll, empty: /暂无未完成任务/.test(text(root)), hasNext: Boolean(next) };
  }, { course });
}

async function openCatalogOnce(page) {
  try { await gotoReadOnly(page, HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (cause) {
    const error = new Error('雨课堂目录导航未能恢复', { cause });
    error.code = 'YUKETANG_NAVIGATION_FAILED';
    throw error;
  }
  const tab = page.getByRole('tab', { name: '我听的课', exact: true });
  await tab.waitFor({ timeout: 15000 });
  // v2 restores the last route asynchronously. Clicking before hydration can
  // bounce a newly selected course back to the index with its query string.
  await page.waitForTimeout(1500);
  if (await tab.getAttribute('aria-selected') !== 'true') {
    await tab.click();
    await page.waitForTimeout(700);
  }
  await page.locator(`${CARD} h1`).first().waitFor({ timeout: 15000 });
  let count = -1;
  for (let pass = 0; pass < 8; pass++) {
    const nextCount = await page.locator(`${CARD} h1`).count();
    if (nextCount === count) break;
    count = nextCount;
    await page.locator(`${CARD} h1`).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
  const catalog = await inspectYuketangCourses(page);
  if (!catalog.authenticated || !catalog.studentSelected || catalog.loading || catalog.loadError) {
    throw new Error('雨课堂课程目录尚未稳定加载');
  }
  return catalog;
}

function loginRequiredError() {
  const error = new Error('雨课堂登录已失效，请重新连接账号。');
  error.code = 'YUKETANG_LOGIN_REQUIRED';
  return error;
}

async function openCatalog(page) {
  // Navigation has its own bounded network retry; repeat the DOM load once for
  // interrupted SPA/API hydration, not indefinitely and never submit a login.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await openCatalogOnce(page); }
    catch (error) {
      const snapshot = await inspectYuketangCourses(page).catch(() => null);
      if (snapshot?.loginRequired) throw loginRequiredError();
      // Do not multiply the navigation helper's retry budget. A locator timeout
      // is different: its network request succeeded but the SPA did not hydrate.
      if (error.code === 'YUKETANG_NAVIGATION_FAILED' || attempt === 1 || page.isClosed()) throw error;
      await page.waitForTimeout(1000);
    }
  }
}

async function openCourse(page, course) {
  const catalog = await openCatalog(page);
  if (!catalog.studentSelected) throw new Error('未选中我听的课');
  let card = page.locator(CARD).filter({ has: page.getByRole('heading', { name: course.title, exact: true }) });
  if (course.className) card = card.filter({ hasText: course.className });
  if (await card.count() !== 1) throw new Error('课程卡片有歧义或已变更');
  await card.locator('h1').click();
  await page.waitForURL((url) => isYuketangCourseUrl(url.href), { timeout: 15000 });
  const observedCourseUrl = page.url();
  await page.waitForTimeout(1000);
  if (!isYuketangCourseUrl(page.url())) await gotoReadOnly(page, observedCourseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByText('未完成', { exact: true }).click({ timeout: 15000 });
  await page.locator(ROOT).waitFor({ timeout: 15000 });
  const allRange = page.locator(`${ROOT} .unfinished-study__range-tab`).filter({ hasText: /^\s*全部待办/ });
  if (!(await allRange.getAttribute('class')).includes('--active')) await allRange.click();
  const allTimeouts = page.locator(`${ROOT} .unfinished-study__timeout-tab`).filter({ hasText: /^\s*全部/ });
  if (!(await allTimeouts.getAttribute('class')).includes('--active')) await allTimeouts.click();
  const allTypes = page.locator(`${ROOT} .unfinished-study__type-tab`).filter({ hasText: /^\s*全部/ });
  if (!(await allTypes.getAttribute('class')).includes('--active')) await allTypes.click();
  const scoreCheckbox = page.locator(`${ROOT} .unfinished-study__score-checkbox input`);
  if (await scoreCheckbox.isChecked()) await page.locator(`${ROOT} .unfinished-study__score-checkbox`).click();
  await page.waitForTimeout(1200);
}

async function stableUnfinished(page, course) {
  let previous = '';
  let stable = 0;
  let latest;
  for (let tries = 0; tries < 24; tries++) {
    latest = await inspectYuketangUnfinished(page, course);
    const key = JSON.stringify({ total: latest.total, records: latest.records, empty: latest.empty, filtersAll: latest.filtersAll });
    stable = latest.ready && key === previous ? stable + 1 : 0;
    if (stable >= 2) return latest;
    previous = key;
    await page.waitForTimeout(350);
  }
  return { ...latest, ready: false };
}

export function normalizeYuketangMaterialState(known, record) {
  if (!known.externalId || known.kind !== 'material' || record?.title !== known.title) return null;
  const text = cleanText(record.progress);
  const count = text.match(/(?:进行中|已完成|已读完)?\s*\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?/);
  const progress = count ? { completed: Number(count[1]), total: Number(count[2]), unit: '页' }
    : known.progress ? { ...known.progress } : null;
  const item = { ...known, url: record.url || known.url, kind: 'material' };
  if (count && progress.total > 0 && progress.completed <= progress.total) {
    Object.assign(item, materialProgressState(progress.completed, progress.total));
    item.progress = progress;
  } else if (/^(?:已完成|已学完|已读完)$/.test(text)) {
    item.status = 'completed'; item.statusLabel = '课件已完成阅读';
    if (progress?.total > 0) item.progress = { ...progress, completed: progress.total };
  } else if (text === '未开始') {
    item.status = 'pending'; item.statusLabel = '课件未开始';
    if (progress) item.progress = { ...progress, completed: 0 };
  } else return null;
  item.statusEvidence = `雨课堂「学习内容」目录中，课件「${record.title}」显示「${text}」。`;
  return item;
}

async function recoverFinishedMaterials(page, known) {
  // A resource disappearing from “unfinished” does not prove completion. Read
  // the observed course-content directory, never the resource viewer itself.
  if (!isYuketangCourseUrl(page.url())) throw new Error('当前不是已核对的课程目录');
  const courseId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  await page.getByText('学习内容', { exact: true }).click({ timeout: 15000 });
  let content;
  for (let attempt = 0; attempt < 40; attempt++) {
    content = page.frames().find(frame => {
      try { const u = new URL(frame.url()); return u.origin === 'https://www.yuketang.cn' && u.pathname.match(/^\/pro\/lms\/[^/]+\/(\d+)\/studycontent$/)?.[1] === courseId; } catch { return false; }
    });
    if (content) break;
    await page.waitForTimeout(250);
  }
  if (!content) throw new Error('学习内容目录未加载');
  await content.locator('.leaf-detail').first().waitFor({ state: 'visible', timeout: 15000 });
  const records = await content.evaluate(() => [...document.querySelectorAll('.leaf-detail')]
    .filter(row => row.getClientRects().length && row.querySelector('.icon--Hkejian2'))
    .map(row => ({ title: row.querySelector('.leaf-title .title')?.textContent?.trim(), progress: row.querySelector('.progress-wrap')?.textContent?.trim() })));
  return known.map(item => {
    const matches = records.filter(row => row.title === item.title);
    return matches.length === 1 ? normalizeYuketangMaterialState(item, { ...matches[0], url: page.url() }) : null;
  });
}

export async function collectYuketangAssignments({ platform, context, page, knownAssignments = [], onProgress = () => {} }) {
  const assignments = new Map();
  const coursesRead = [];
  const issues = [];
  // null means unverified (e.g. offline/SPA failure), false requires login UI.
  let authenticated = null;
  let catalog;
  let worker;
  let ignoredResources = 0;
  let materialHomework = 0;
  try {
    worker = await context.newPage();
    worker.setDefaultTimeout(15000);
    catalog = await openCatalog(worker);
    authenticated = catalog.authenticated && catalog.studentSelected;
    if (!authenticated) return { assignments: [], authenticated: catalog.loginRequired ? false : null, complete: false,
      message: catalog.loginRequired ? '雨课堂登录已过期，请重新连接账号。' : '雨课堂课程目录未加载，保留原清单，将自动重试。' };
    const limit = Math.min(Math.max(Number(platform.maxCourses) || 200, 1), 500);
    if (catalog.hasMore) issues.push('课程目录还有未遍历的分页');
    if (catalog.courses.length > limit) issues.push(`课程数超过单次 ${limit} 门上限`);
    for (const [index, course] of catalog.courses.slice(0, limit).entries()) {
      onProgress(`雨课堂：正在读取「${course.title}」（${index + 1}/${catalog.courses.length}）`);
      try {
        await openCourse(worker, course);
        const seenTasks = new Map();
        let snapshot;
        let complete = false;
        for (let pass = 0; pass < 40; pass++) {
          snapshot = await stableUnfinished(worker, course.title);
          if (!snapshot.ready || !snapshot.filtersAll || !isYuketangCourseUrl(snapshot.url)) break;
          for (const record of snapshot.records) seenTasks.set(record.id || `${record.kind}:${record.title}`, record);
          if (snapshot.total !== null && seenTasks.size === snapshot.total && (snapshot.total > 0 || snapshot.empty)) { complete = true; break; }
          if (snapshot.hasNext) {
            await worker.locator(`${ROOT} .el-pagination .btn-next, ${ROOT} button[aria-label="下一页"], ${ROOT} button[title="下一页"]`).filter({ visible: true }).first().click();
          } else {
            const before = seenTasks.size;
            const rows = worker.locator(`${ROOT} .unfinished-study__item`);
            if (await rows.count()) await rows.last().scrollIntoViewIfNeeded();
            await worker.waitForTimeout(800);
            const more = await stableUnfinished(worker, course.title);
            for (const record of more.records) seenTasks.set(record.id || `${record.kind}:${record.title}`, record);
            if (seenTasks.size === before) break;
          }
        }
        for (const record of seenTasks.values()) {
          const item = normalizeYuketangTask(record);
          if (item) {
            assignments.set(item.externalId, item);
            if (item.kind === 'material') materialHomework++;
            if (item.status === 'unknown') { complete = false; issues.push(`「${course.title}」课件个人阅读进度未能读取`); }
          } else ignoredResources++;
        }
        const missingMaterials = knownAssignments.filter(item => item.kind === 'material' && item.externalId && item.course === course.title && isYuketangCourseUrl(item.url) && new URL(item.url).pathname === new URL(worker.url()).pathname && !assignments.has(item.externalId));
        if (missingMaterials.length) {
          const recovered = await recoverFinishedMaterials(worker, missingMaterials);
          for (const item of recovered) {
            if (item) { assignments.set(item.externalId, item); materialHomework++; }
            else { complete = false; issues.push(`「${course.title}」有历史课件未能在学习内容目录核实状态`); }
          }
        }
        coursesRead.push({ title: course.title, className: course.className, url: worker.url(), total: snapshot?.total ?? null, tasksRead: seenTasks.size, complete });
        if (!complete) issues.push(`「${course.title}」的列表数量或分页未能完整核对`);
      } catch (error) {
        issues.push(`「${course.title}」读取失败或页面结构变化`);
        if (worker.isClosed()) break;
        const expired = error.code === 'YUKETANG_LOGIN_REQUIRED'
          || (await inspectYuketangCourses(worker).catch(() => null))?.loginRequired;
        if (expired) { authenticated = false; issues.push('登录已过期，请重新连接雨课堂'); break; }
      }
    }
    const complete = issues.length === 0 && coursesRead.length === catalog.courses.length && catalog.courses.length > 0;
    return {
      assignments: [...assignments.values()], authenticated, complete,
      message: `课程 ${coursesRead.length}/${catalog.courses.length} 门；作业相关任务 ${assignments.size} 项。`
        + (ignoredResources ? `普通学习资料 ${ignoredResources} 项未计入。` : '')
        + (materialHomework ? `其中 ${materialHomework} 项是课件，按阅读进度显示。` : '')
        + (issues.length ? `未读全：${issues.slice(0, 4).join('；')}。` : '不含归档课程。'),
      diagnostics: { courses: coursesRead, ignoredResources, materialHomework, issues },
    };
  } catch (error) {
    const expired = error.code === 'YUKETANG_LOGIN_REQUIRED'
      || (worker && await inspectYuketangCourses(worker).catch(() => null))?.loginRequired;
    if (expired) authenticated = false;
    return { assignments: [...assignments.values()], authenticated, complete: false,
      message: expired ? '雨课堂登录已过期，请重新连接账号。'
        : '雨课堂课程目录未加载，保留原清单，将自动重试。',
      diagnostics: { courses: coursesRead, issues } };
  } finally {
    if (worker) await worker.close().catch(() => {});
  }
}
