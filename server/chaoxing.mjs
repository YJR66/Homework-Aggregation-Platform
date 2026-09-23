import { cleanText, extractDeadline, parseDueAt, parseStatus, safeHttpUrl } from './parsers.mjs';
import { gotoReadOnly } from './navigation.mjs';

// Verified against the signed-in legacy course list and current mooc2 work list.
// The only clicks performed are the course's “作业” navigation and list pagination.
export const CHAOXING_CAPABILITY = { name: '学习通', mode: 'verified-course-work-list', verifiedAuthenticated: true, source: 'https://i.chaoxing.com/' };

export function chaoxingUrl(value, base) {
  const href = safeHttpUrl(value, base);
  if (!href) return '';
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) return '';
  return href;
}

export function parseChaoxingCountdown(value, { now = new Date() } = {}) {
  const text = cleanText(value);
  if (!/^剩余/.test(text)) return null;
  const parts = [...text.matchAll(/(\d+)\s*(天|小时|时|分钟|分|秒钟|秒)/g)];
  if (!parts.length) return null;
  let milliseconds = 0;
  for (const [, quantity, unit] of parts) milliseconds += Number(quantity) * (/天/.test(unit) ? 86400000 : /小时|时/.test(unit) ? 3600000 : /分钟|分/.test(unit) ? 60000 : 1000);
  // The UI rounds countdowns. Preserve that uncertainty instead of claiming an exact deadline.
  return new Date(Math.floor(new Date(now).getTime() / 60000) * 60000 + milliseconds).toISOString();
}

export function normalizeChaoxingWork(record, course, { now = new Date() } = {}) {
  const title = cleanText(record.title);
  const url = chaoxingUrl(record.url);
  if (!url || !title || title.length > 250 || course.closed) return null;
  const parsedUrl = new URL(url);
  if (!/\/work\/task$/.test(parsedUrl.pathname)) return null;
  const workId = parsedUrl.searchParams.get('workId');
  if (!workId || !/^\d+$/.test(workId)) return null;
  const courseId = String(course.courseId || parsedUrl.searchParams.get('courseId') || '');
  const classId = String(course.classId || parsedUrl.searchParams.get('classId') || '');
  if (!courseId || !classId) return null;
  const dueText = cleanText(record.timeText || '');
  const exact = parseDueAt(extractDeadline(dueText) || dueText, { now });
  const estimated = exact ? null : parseChaoxingCountdown(dueText, { now });
  const dueAt = exact || estimated;
  const status = parseStatus(`${record.statusText || ''} ${dueText}`, dueAt, { now });
  return {
    externalId: `chaoxing:${courseId}:${classId}:${workId}`,
    title,
    course: cleanText(course.title),
    dueAt,
    dueAtEstimated: Boolean(estimated),
    dueText,
    status,
    kind: 'assignment',
    statusLabel: status === 'submitted' ? (/待批阅/.test(record.statusText || '') ? '已提交 · 待批阅' : '平台已提交')
      : ['pending', 'overdue'].includes(status) ? `${/打回|退回|重新提交|未通过/.test(record.statusText || '') ? '需重新提交' : '未提交'}${status === 'overdue' ? ' · 已截止' : ''}` : '作业状态读取失败',
    statusEvidence: `学习通作业列表显示「${cleanText(record.statusText || '未提供')}」${dueText ? `；时间「${dueText}」` : ''}。`,
    url,
  };
}

export function verifyChaoxingWorkCoverage({ total, seen, allFilter, invalidRows = 0 }) {
  return Number.isInteger(total) && total >= 0 && seen === total && allFilter === true && invalidRows === 0;
}

export async function inspectChaoxingCourses(frame) {
  return frame.evaluate(() => {
    const text = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const root = document.querySelector('#courseList.course-list');
    const allRows = root ? [...root.querySelectorAll(':scope > li.course[courseid][clazzid]')] : [];
    const courses = allRows.map((row) => ({
      courseId: row.getAttribute('courseid'), classId: row.getAttribute('clazzid'),
      title: row.querySelector('.course-name')?.getAttribute('title') || text(row.querySelector('.course-name')),
      url: row.querySelector('.course-info h3 a')?.href || '',
      closed: Boolean(row.querySelector('.not-open-tip')) || /课程已结束/.test(text(row)),
    }));
    const folderCount = document.querySelector('#courseFolderSize')?.value;
    const controls = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible);
    const next = controls.find((el) => /^(?:下一页|下页|加载更多|更多课程|Next)$/.test(text(el)) && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(el.className || ''));
    const filtered = [...document.querySelectorAll('input[type="text"],input[type="search"]')].some((el) => visible(el) && el.value.trim());
    return { recognized: Boolean(root) && /我学的课/.test(document.body.innerText), courses, rowCount: allRows.length, folderCount: folderCount === undefined ? null : Number(folderCount), hasMore: Boolean(next), filtered };
  });
}

export async function inspectChaoxingWorks(frame) {
  return frame.evaluate(() => {
    const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const progress = text(document.querySelector('.work-progress-box')).match(/^(\d+)\s*\/\s*(\d+)$/);
    const allFilter = document.querySelector('input[name="group-radio"]:checked')?.getAttribute('data') === '0' && document.querySelector('#status')?.value === '0';
    const rows = [...document.querySelectorAll('.bottomList ul li[data]')];
    const records = rows.map((row) => ({ title: text(row.querySelector('.right-content p.overHidden2')), statusText: text(row.querySelector('p.status')), timeText: text(row.querySelector('.time')), url: row.getAttribute('data') }));
    const controls = [...document.querySelectorAll('#page a,#page button,#page [role="button"]')].filter(visible);
    const next = controls.find((el) => /^(?:下一页|下页|Next|›|»|>)$/.test(text(el) || el.getAttribute('aria-label') || '') && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(el.className || ''));
    return { recognized: /\/work\/list(?:[?#]|$)/.test(location.href) && document.title === '作业列表', records, completed: progress ? Number(progress[1]) : null, total: progress ? Number(progress[2]) : null, allFilter, empty: /暂无作业/.test(document.body.innerText), next: next ? { text: text(next), aria: next.getAttribute('aria-label') || '' } : null };
  });
}

async function findWorkFrame(page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const frame = page.frames().find((candidate) => chaoxingUrl(candidate.url()) && /\/work\/list(?:[?#]|$)/.test(candidate.url()));
    if (frame) {
      await frame.locator('.work-progress-box').waitFor({ state: 'visible', timeout: 12000 });
      return frame;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function hasLoginEvidence(page) {
  const href = chaoxingUrl(page.url());
  if (href) {
    const url = new URL(href);
    if (/^passport\d*\.chaoxing\.com$/.test(url.hostname) && /\/(?:login|fanyalogin)(?:\/|$)/.test(url.pathname)) return true;
  }
  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

async function loadCourseDirectory(page, report) {
  // An iframe can fail independently of the top-level document. Retry the
  // read-only directory once, but never interpret a missing iframe as logout.
  for (let attempt = 0; attempt < 2; attempt++) {
    await gotoReadOnly(page, 'https://i.chaoxing.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('iframe#frame_content, input[type="password"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await hasLoginEvidence(page)) return { authenticated: false };
    try {
      let courseFrame;
      for (let poll = 0; poll < 30; poll++) {
        courseFrame = page.frames().find((frame) => chaoxingUrl(frame.url()) && /\/visit\/interaction(?:[?#]|$)/.test(frame.url()));
        if (courseFrame) break;
        await page.waitForTimeout(250);
      }
      if (!courseFrame) throw new Error('课程 iframe 未加载');
      await courseFrame.locator('#courseList').waitFor({ state: 'attached', timeout: 15000 });
      let registry = await inspectChaoxingCourses(courseFrame);
      const originalCount = registry.courses.length;
      // This observed legacy list is server-rendered; check for lazy-added rows.
      await courseFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      registry = await inspectChaoxingCourses(courseFrame);
      if (registry.recognized) return { authenticated: true, registry, originalCount };
    } catch {
      // A timeout, detached iframe or unknown DOM does not prove session expiry.
    }
    if (await hasLoginEvidence(page)) return { authenticated: false };
    if (attempt === 0) {
      report('学习通：课程目录未完整加载，正在重试只读页面');
      await page.waitForTimeout(500);
    }
  }
  return { authenticated: null };
}

export async function collectChaoxingAssignments({ platform, context, onProgress = () => {} }) {
  const assignments = new Map();
  const warnings = [];
  let listingPage, coursePage;
  let authenticated = null;
  let activeCourses = [];
  let closedCourses = 0;
  let readCourses = 0;
  let completeCourses = 0;
  let completeListing = false;
  const maxCourses = Math.min(Math.max(Number(platform.maxCourses) || 100, 1), 300);
  const maxPages = Math.min(Math.max(Number(platform.maxPages) || 40, 1), 100);
  const report = (message) => { try { onProgress(message); } catch {} };
  try {
    listingPage = await context.newPage();
    const directory = await loadCourseDirectory(listingPage, report);
    authenticated = directory.authenticated;
    if (authenticated === false) return { assignments: [], complete: false, authenticated: false, message: '学习通登录已失效，请先重新登录。' };
    if (authenticated !== true) return { assignments: [], complete: false, authenticated: null, message: '学习通课程目录未加载，保留原清单。请稍后重试。' };
    const { registry, originalCount } = directory;
    const unique = new Map();
    let invalidCourses = 0;
    for (const course of registry.courses) {
      if (!course.title || !chaoxingUrl(course.url) || !/\/visit\/stucoursemiddle\?/.test(course.url)) { invalidCourses++; continue; }
      unique.set(`${course.courseId}:${course.classId}`, course);
    }
    // A class can appear more than once in the legacy directory; count each
    // course/class pair once before checking listing completeness.
    const courses = [...unique.values()];
    closedCourses = courses.filter((course) => course.closed).length;
    activeCourses = courses.filter((course) => !course.closed);
    completeListing = registry.recognized && registry.folderCount === 0 && !registry.hasMore && !registry.filtered && originalCount === registry.courses.length && invalidCourses === 0;
    if (!completeListing) warnings.push('课程列表存在文件夹、筛选、分页或未识别项，范围尚未完全核对');
    if (activeCourses.length > maxCourses) warnings.push(`未结课课程超过 ${maxCourses} 门读取上限`);
    coursePage = await context.newPage();
    for (const course of activeCourses.slice(0, maxCourses)) {
      report(`学习通：正在读取 ${course.title} 的作业（${readCourses + 1}/${activeCourses.length}）`);
      let courseComplete = false;
      try {
        await gotoReadOnly(coursePage, course.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        if (await hasLoginEvidence(coursePage)) {
          authenticated = false;
          warnings.push('学习通登录在读取期间失效，请重新登录');
          break;
        }
        const menu = coursePage.locator('a[title="作业"][data-url]');
        await menu.waitFor({ state: 'visible', timeout: 12000 });
        const menuUrl = chaoxingUrl(await menu.getAttribute('data-url'));
        if (!menuUrl || !/\/work\/list$/.test(new URL(menuUrl).pathname)) throw new Error('未识别只读作业菜单');
        await menu.click({ timeout: 5000 });
        let frame = await findWorkFrame(coursePage);
        if (!frame) throw new Error('作业列表未加载');
        const seen = new Set();
        let expected = null;
        let invalidRows = 0;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
          const snapshot = await inspectChaoxingWorks(frame);
          if (!snapshot.recognized || !snapshot.allFilter) throw new Error('不是“全部”作业列表');
          if (expected !== null && expected !== snapshot.total) throw new Error('作业总数在读取期间发生变化');
          expected = snapshot.total;
          const previousSize = seen.size;
          for (const record of snapshot.records) {
            const item = normalizeChaoxingWork(record, course);
            if (item) { assignments.set(item.externalId, item); seen.add(item.externalId); } else invalidRows++;
          }
          if (verifyChaoxingWorkCoverage({ total: expected, seen: seen.size, allFilter: snapshot.allFilter, invalidRows })) { courseComplete = true; break; }
          if (!snapshot.next || (pageIndex > 0 && seen.size === previousSize)) break;
          const root = frame.locator('#page');
          const next = snapshot.next.aria ? root.getByRole('button', { name: snapshot.next.aria, exact: true }).or(root.getByRole('link', { name: snapshot.next.aria, exact: true })) : root.getByText(snapshot.next.text, { exact: true });
          await next.first().click({ timeout: 5000 });
          await coursePage.waitForTimeout(700);
          frame = await findWorkFrame(coursePage);
          if (!frame) break;
        }
        if (!courseComplete) warnings.push(`「${course.title}」分页或作业总数未完整核对`);
      } catch {
        warnings.push(`「${course.title}」未能完整读取作业列表`);
        if (await hasLoginEvidence(coursePage)) {
          authenticated = false;
          warnings.push('学习通登录在读取期间失效，请重新登录');
          break;
        }
      }
      readCourses++;
      if (courseComplete) completeCourses++;
    }
    const items = [...assignments.values()];
    const pending = items.filter((item) => item.status === 'pending').length;
    const overdue = items.filter((item) => item.status === 'overdue').length;
    const submitted = items.filter((item) => item.status === 'submitted').length;
    const estimated = items.filter((item) => item.dueAtEstimated).length;
    const complete = completeListing && completeCourses === activeCourses.length && readCourses === activeCourses.length;
    return {
      assignments: items, complete, authenticated,
      message: `未结课课程 ${completeCourses}/${activeCourses.length} 门；作业 ${items.length} 项（待交 ${pending}、逾期 ${overdue}、已交 ${submitted}）。已结课课程 ${closedCourses} 门未计入。${estimated ? `${estimated} 项截止时间按平台倒计时估算。` : ''}${complete ? '不含考试、章节测验。' : warnings.slice(0, 5).join('；') + '。清单可能不完整。'}`,
    };
  } catch {
    return { assignments: [...assignments.values()], complete: false, authenticated, message: `学习通读取中断，已保留 ${assignments.size} 项；请稍后重试。` };
  } finally {
    if (coursePage) await coursePage.close().catch(() => {});
    if (listingPage) await listingPage.close().catch(() => {});
  }
}
