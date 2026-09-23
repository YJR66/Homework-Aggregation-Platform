import { parseDueAt, parseStatus } from './parsers.mjs';
import { gotoReadOnly } from './navigation.mjs';

const PREFIX = '/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const ROOT = `https://vpn.neuq.edu.cn${PREFIX}`;

// The platform uses index.jsp for scheduled homework and selfindex.jsp for
// exercises. Both are read-only overview pages, but their total-count labels
// differ; a selfindex redirect is not a missing homework or a login failure.
const ASSIGNMENT_TOTAL_PATTERN = '(?:作业满分|总分值\\s*[:：])[\\s\\S]{0,80}共\\s*(\\d+)\\s*道';

export function xijiAssignmentTotal(text = '') {
  const match = String(text).match(new RegExp(ASSIGNMENT_TOTAL_PATTERN));
  return match ? Number(match[1]) : null;
}

export function xijiProxyUrl(raw, base = `${ROOT}main.jsp`) {
  try {
    const u = new URL(raw, base);
    if (u.username || u.password || u.protocol !== 'https:') return '';
    if (u.origin === 'https://vpn.neuq.edu.cn' && u.pathname.startsWith(PREFIX)) return u.href;
    if (u.origin === 'https://ccelab.neuq.edu.cn') return ROOT + u.pathname.slice(1) + u.search;
    // WebVPN leaves root-relative form/link attributes in original-site form.
    if (String(raw).startsWith('/') && !String(raw).startsWith('//') && u.origin === 'https://vpn.neuq.edu.cn') return ROOT + u.pathname.slice(1) + u.search;
    return '';
  } catch { return ''; }
}

export function normalizeXijiCard(record, course) {
  const url = xijiProxyUrl(record.href);
  const id = url && new URL(url).searchParams.get('assignID');
  if (!record.title?.trim() || !id || !/^\d+$/.test(id)
    || new URL(url).pathname !== `${PREFIX}assignment/index.jsp`) return null;
  const dueAt = parseDueAt(record.time);
  return { externalId: `xiji:${course.id}:${id}`, title: record.title.trim(), course: course.name, dueAt,
    // The visible percentage is time progress, not evidence of personal submission.
    status: parseStatus(record.status || '', dueAt), url };
}

export function xijiQuestionState({ text = '', form } = {}) {
  const label = String(text).replace(/\s+/g, ' ').trim();
  if (/(?:还|尚)?未提交(?:代码|答案)?|未作答/.test(label)) return { submitted: false, fullyAnswered: false };
  if (/最后一次提交时间\s*[:：]\s*\d{4}-\d{2}-\d{2}|已提交|已保存/.test(label)) return { submitted: true, fullyAnswered: true };
  if (!form?.verified || !Number.isInteger(form.fields) || form.fields < 1
    || !Number.isInteger(form.filled) || form.filled < 0 || form.filled > form.fields) return null;
  return { submitted: form.filled > 0, fullyAnswered: form.filled === form.fields };
}

export function xijiQuestionIdentity(raw, assignID, base = `${ROOT}assignment/index.jsp`) {
  const resolved = xijiProxyUrl(raw, base);
  if (!resolved) return null;
  const url = new URL(resolved);
  const type = url.pathname.slice(PREFIX.length).match(/^assignment\/(clozeList|optionList|singleOptionList|programFillGapList|programList)\.jsp$/)?.[1];
  const proNum = url.searchParams.get('proNum');
  if (!type || !/^[1-9]\d*$/.test(proNum || '') || url.searchParams.get('assignID') !== String(assignID)
    || url.searchParams.getAll('assignID').length !== 1 || url.searchParams.getAll('proNum').length !== 1) return null;
  return `${assignID}:${type}:${proNum}`;
}

export function verifyXijiQuestionCoverage({ total, rows = [], assignID } = {}) {
  if (!/^\d+$/.test(String(assignID)) || !Number.isInteger(total) || total < 1 || rows.length !== total) return false;
  const identities = rows.map(row => xijiQuestionIdentity(row.href, assignID));
  return identities.every(Boolean) && new Set(identities).size === total;
}

export function normalizeXijiDetails({ total, rows = [], assignID } = {}) {
  if (!verifyXijiQuestionCoverage({ total, rows, assignID })) return null;
  const states = rows.map(xijiQuestionState);
  if (states.some(state => !state)) return null;
  const submitted = states.filter(state => state.submitted).length;
  const fullyAnswered = states.filter(state => state.fullyAnswered).length;
  const objectiveForms = rows.filter(row => row.form?.verified).length;
  // A saved but incomplete objective answer counts as a submission attempt,
  // not proof that the entire assignment has been completed.
  return { kind: 'assignment', status: fullyAnswered === total ? 'submitted' : submitted ? 'in_progress' : 'pending', detailComplete: true,
    progress: { total, submitted, unit: '题' },
    statusLabel: submitted === 0 ? `未提交（0/${total} 题）` : fullyAnswered === total ? `已全部提交（${total}/${total} 题）` : `已提交 ${submitted}/${total} 题`,
    statusEvidence: `个人答题记录：已提交 ${submitted}/${total} 题，完整作答 ${fullyAnswered}/${total} 题。提交不等于通过。${objectiveForms ? `已读取 ${objectiveForms} 道客观题的个人答案。` : ''}` };
}

export function normalizeXijiPartialDetails(snapshot) {
  if (!verifyXijiQuestionCoverage(snapshot)) return null;
  const states = snapshot.rows.map(xijiQuestionState);
  const failed = states.filter(state => !state).length;
  if (!failed) return null;
  const unsubmitted = states.filter(state => state && !state.submitted).length;
  const submitted = states.filter(state => state?.submitted).length;
  return { kind: 'assignment', status: unsubmitted ? 'pending' : 'unknown', progress: { total: snapshot.total, unit: '题' },
    statusLabel: unsubmitted ? `未完成（${unsubmitted} 题明确未提交）` : '个人提交记录读取失败',
    statusEvidence: `共 ${snapshot.total} 题，已读到 ${states.length - failed} 题：未提交 ${unsubmitted} 题，有提交记录 ${submitted} 题。另有 ${failed} 题个人提交信息读取失败，已提交总数待确认。`,
    detailComplete: false };
}

// selfindex.jsp is the authenticated personal exercise overview, not the
// homework submission table. Its per-kind progress counts completed exercises;
// neither the score nor a zero progress value is a submission count.
export function extractXijiPracticeSnapshot() {
  return {
    body: document.body?.innerText || '',
    rows: [...document.querySelectorAll('tr[id^="indexProsByKindDIV"]')].map(row => {
      const cells = [...row.querySelectorAll(':scope > td')];
      return { id: row.id, progressText: cells[1]?.querySelector('small.text-muted')?.textContent?.trim() || '' };
    })
  };
}

export function normalizeXijiPracticeDetails({ total, rows = [], assignID, url, sourceUrl } = {}) {
  const source = xijiProxyUrl(sourceUrl);
  const current = xijiProxyUrl(url);
  if (!source || !current || !/^[1-9]\d*$/.test(String(assignID))
    || !Number.isSafeInteger(total) || total < 1 || !rows.length) return null;
  const sourceLocation = new URL(source);
  const currentLocation = new URL(current);
  if (sourceLocation.pathname !== `${PREFIX}assignment/index.jsp`
    || sourceLocation.searchParams.getAll('assignID').length !== 1
    || sourceLocation.searchParams.get('assignID') !== String(assignID)
    || currentLocation.pathname !== `${PREFIX}assignment/selfindex.jsp`
    || currentLocation.searchParams.getAll('assignID').length !== 1
    || !currentLocation.searchParams.get('assignID')) return null;
  const kinds = new Set();
  let count = 0; let completed = 0;
  for (const row of rows) {
    const identity = String(row.id || '').match(/^indexProsByKindDIV([1-9]\d*)_([1-9]\d*)$/);
    const progress = String(row.progressText || '').match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!identity || identity[2] !== String(assignID) || kinds.has(identity[1]) || !progress) return null;
    const done = Number(progress[1]); const size = Number(progress[2]);
    if (!Number.isSafeInteger(done) || !Number.isSafeInteger(size) || size < 1 || done > size) return null;
    kinds.add(identity[1]); count += size; completed += done;
  }
  if (!Number.isSafeInteger(count) || count !== total) return null;
  return {
    kind: 'assignment', status: completed === total ? 'completed' : 'in_progress',
    progress: { completed, total, unit: '题' }, detailComplete: true,
    statusLabel: `练习${completed === total ? '已完成' : '待完成'}（${completed}/${total} 题）`,
    statusEvidence: `个人练习概览：${kinds.size} 类题，共 ${total} 题，已完成 ${completed} 题。题型合计与总题数一致；这是完成进度，不是逐题提交次数，也不按得分或卡片时间推断提交。`
  };
}

// Only a GET of the observed homework form is made. Its scripts are not executed:
// the site's onchange handlers automatically submit answers, so never fill a form.
export async function readXijiObjectiveState(page, raw, assignID) {
  const url = xijiProxyUrl(raw, page.url());
  if (!url) throw new Error('客观题地址不受信任');
  const target = new URL(url);
  if (!xijiQuestionIdentity(url, assignID) || !/(?:clozeList|optionList|singleOptionList)\.jsp$/.test(target.pathname)) throw new Error('不是已识别的作业题目查看地址');
  return page.evaluate(async ({ url, assignID, root }) => {
    const get = async value => {
      const request = new URL(value);
      if (request.origin !== location.origin || !value.startsWith(root)) throw new Error('题目资源地址不受信任');
      const response = await fetch(value, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
      const received = new URL(response.url);
      // WebVPN appends this observed empty transport marker without redirecting.
      // It may be ignored, but no business parameter, origin, or path may change.
      const marker = 'vpn-12-o2-ccelab.neuq.edu.cn';
      const markers = received.searchParams.getAll(marker);
      const expectedEntries = [...request.searchParams];
      received.searchParams.delete(marker);
      const receivedEntries = [...received.searchParams];
      const canonical = entries => JSON.stringify(entries.toSorted(([a], [b]) => a.localeCompare(b)));
      if (!response.ok || response.redirected || markers.length > 1 || markers.some(value => value !== '')
        || request.searchParams.has(marker) || received.origin !== request.origin || received.pathname !== request.pathname
        || received.username || received.password || received.hash !== request.hash
        || new Set(expectedEntries.map(([key]) => key)).size !== expectedEntries.length
        || new Set(receivedEntries.map(([key]) => key)).size !== receivedEntries.length
        || canonical(expectedEntries) !== canonical(receivedEntries)) throw new Error('题目读取失败');
      return response.text();
    };
    const doc = new DOMParser().parseFromString(await get(url), 'text/html');
    const forms = [...doc.querySelectorAll('form[name^="answerForm"],form[id^="answerForm"]')].filter(f => {
      const ids = f.querySelectorAll('input[name="assignID"]');
      return ids.length === 1 && ids[0].type === 'hidden' && ids[0].value === assignID;
    });
    const form = forms.length === 1 ? forms[0] : null;
    if (!form || !/^(?:\.\/)?stuAnswerHandler\.jsp$/.test(form.getAttribute('action') || '')) return { verified: false };
    const problems = form.querySelectorAll('input[name="problemID"]');
    const problemID = problems[0]?.value || '';
    if (problems.length !== 1 || problems[0].type !== 'hidden' || !/^[1-9]\d*$/.test(problemID)
      || ![form.getAttribute('name'), form.getAttribute('id')].filter(Boolean).every(value => value === `answerForm${problemID}`)) return { verified: false };
    const status = [...form.querySelectorAll('[id^="saveTip"]')].map(e => e.textContent.trim()).filter(Boolean).join(' ');
    let controls = [...form.querySelectorAll('input[name^="answer"],textarea[name^="answer"],select[name^="answer"]')].filter(e => e.type !== 'hidden');
    if (!controls.length && new URL(url).pathname.endsWith('/assignment/singleOptionList.jsp')) {
      // The personal response chooses the markdown resource and its target in
      // this exact answer form. Never derive a state from a template/key alone.
      // Resolve only the observed WebVPN shim for the known renderer path.
      const renderer = [...doc.querySelectorAll('script[src]')].some(script => {
        let source;
        try { source = new URL(script.getAttribute('src'), url); } catch { return false; }
        if (source.username || source.password || source.search || source.hash || source.origin !== location.origin) return false;
        const path = new URL(root).pathname;
        return source.pathname === `${path}includes/cherrymd/mdPreview.v4.js` || source.pathname === '/includes/cherrymd/mdPreview.v4.js';
      });
      if (!renderer) return { verified: false, status };
      const renderScripts = [...form.querySelectorAll('script:not([src])')].filter(script => /\bcgRenderMarkdown\b/.test(script.textContent));
      const calls = renderScripts.map(script => script.textContent.trim().match(
        /^cgRenderMarkdown\s*\(\s*(['"])([A-Za-z0-9_]+)\1\s*,\s*false\s*,\s*(['"])([A-Za-z0-9_]+)\3\s*\)\s*;?$/
      )).filter(Boolean);
      const containerID = `cgmdoptSingleOptions0_${problemID}`;
      const bindings = calls.filter(call => call[4] === containerID);
      const containers = [...doc.querySelectorAll('[id]')].filter(element => element.id === containerID);
      if (calls.length !== renderScripts.length || bindings.length !== 1
        || !new RegExp(`^optSingleOptions0_${problemID}[a-fA-F0-9]{32}$`).test(bindings[0][2])
        || containers.length !== 1 || !form.contains(containers[0])
        || containers[0].children.length || containers[0].textContent.trim()) return { verified: false, status };
      const resourceUrl = new URL('downMarkdown', root);
      resourceUrl.searchParams.set('mkdoc', bindings[0][2]);
      const resource = new DOMParser().parseFromString(await get(resourceUrl.href), 'text/html');
      // Detached DOMParser documents are never attached to the page. Scripts,
      // onclick=this.form.submit(), and other handlers cannot run while reading.
      if (resource.querySelector('script,form,iframe,object,embed,base')) return { verified: false, status };
      controls = [...resource.querySelectorAll('input,textarea,select')];
      const values = new Set();
      if (controls.length < 2 || controls.length > 26 || controls.some(control => {
        if (control.tagName !== 'INPUT' || control.type !== 'radio' || control.name !== 'answer1'
          || !/^[A-Z]$/.test(control.value) || control.id !== `cgsingleOpt0_${problemID}${control.value}`
          || control.hasAttribute('form') || values.has(control.value)) return true;
        values.add(control.value);
        return false;
      })) return { verified: false, status };
    }
    if (!controls.length) return { verified: false, status };
    const groups = new Map();
    for (const control of controls) {
      const name = control.name;
      const choice = /^(?:radio|checkbox)$/.test(control.type);
      const filled = choice ? control.hasAttribute('checked') : Boolean(control.value.trim());
      const group = groups.get(name) || { type: control.type, filled: false, selected: 0 };
      if (group.type !== control.type || control.type === 'radio' && filled && group.selected) return { verified: false, status };
      group.filled ||= filled;
      if (filled) group.selected++;
      groups.set(name, group);
    }
    return { verified: groups.size > 0, fields: groups.size, filled: [...groups.values()].filter(group => group.filled).length, status };
  }, { url, assignID: String(assignID), root: ROOT });
}

export async function collectXijiDetails(page, item) {
  await gotoReadOnly(page, item.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(pattern => new RegExp(pattern).test(document.body?.innerText || '') || document.querySelector('input[type="password"]'), ASSIGNMENT_TOTAL_PATTERN, { timeout: 20000 });
  const assignID = new URL(item.url).searchParams.get('assignID');
  const currentUrl = xijiProxyUrl(page.url());
  if (currentUrl && new URL(currentUrl).pathname === `${PREFIX}assignment/selfindex.jsp`) {
    const snapshot = await page.evaluate(extractXijiPracticeSnapshot);
    const normalized = normalizeXijiPracticeDetails({ total: xijiAssignmentTotal(snapshot.body), rows: snapshot.rows,
      assignID, url: currentUrl, sourceUrl: item.url });
    if (!normalized) throw new Error('个人练习概览题型或题数不完整');
    return { ...item, ...normalized };
  }
  const snapshot = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const rows = [...document.querySelectorAll('table')].filter(table => /提交状态|批阅信息/.test(table.querySelector(':scope > thead')?.innerText || '')).flatMap(table => [...table.querySelectorAll(':scope > tbody > tr')].map(row => {
      const cells = [...row.querySelectorAll(':scope > td')];
      return { text: cells.at(-1)?.innerText || '', href: cells[0]?.querySelector('a[href]')?.getAttribute('href') || '' };
    }));
    return { body, rows };
  });
  snapshot.total = xijiAssignmentTotal(snapshot.body);
  delete snapshot.body;
  snapshot.assignID = assignID;
  if (!verifyXijiQuestionCoverage(snapshot)) throw new Error('作业题目明细数量或唯一题号不完整');
  for (const row of snapshot.rows) {
    if (xijiQuestionState(row)) continue;
    const objectiveUrl = xijiProxyUrl(row.href, page.url());
    if (!objectiveUrl || !xijiQuestionIdentity(objectiveUrl, assignID)
      || !/(?:clozeList|optionList|singleOptionList)\.jsp$/.test(new URL(objectiveUrl).pathname)) continue;
    // The personal form or its selected markdown resource can be temporarily
    // empty. Re-read this trusted GET-only path once; never retry an answer POST
    // or manufacture a status when both reads remain unverified.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        row.form = await readXijiObjectiveState(page, objectiveUrl, assignID);
        if (row.form.status) row.text = row.form.status;
      } catch { row.form = { verified: false }; }
      if (row.form.verified || attempt === 1 || page.isClosed?.()) break;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  const normalized = normalizeXijiDetails(snapshot) || normalizeXijiPartialDetails(snapshot);
  if (!normalized) throw new Error('存在未核验的题目提交记录');
  return { ...item, ...normalized };
}

async function waitForList(page) {
  await page.waitForFunction(() => document.querySelector('#activeActionDIV') || document.querySelector('a[href*="courselist.jsp?courseID="]') || document.querySelector('input[type="password"]'), null, { timeout: 25000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

export async function inspectXijiPage(page) {
  return page.evaluate(() => {
    const visible = el => Boolean(el.getClientRects().length);
    const text = el => (el?.innerText || el?.textContent || '').trim();
    const links = [...document.querySelectorAll('a[href*="courselist.jsp?courseID="]')].filter(visible).map(a => ({ href: a.getAttribute('href'), name: text(a) }));
    const courses = [...new Map([...document.querySelectorAll('.dropdown-item-course[value]')].map(e => [e.getAttribute('value'), { id: e.getAttribute('value'), name: text(e), selected: e.classList.contains('font-weight-bold') }])).values()];
    const cards = [...document.querySelectorAll('#activeActionDIV .main-zy')].map(e => ({ title: text(e.querySelector('.main-title')), time: text(e.querySelector('.main-time')), href: e.querySelector('a[href*="assignID="]')?.getAttribute('href'), status: text(e.querySelector('.assignment-status')) }));
    const pagination = [...document.querySelectorAll('#activeActionDIV .pagination,#activeActionDIV [class*="page"],#activeActionDIV a')].some(e => /下一页|加载更多/.test(text(e)));
    return { url: location.href, login: [...document.querySelectorAll('input[type="password"]')].some(visible), links, courses, cards,
      hasList: Boolean(document.querySelector('#activeActionDIV') && document.querySelector('#courseDropdown')), pagination };
  });
}

export async function collectXijiAssignments({ platform, context, page, onProgress = () => {} }) {
  const assignments = new Map(); const failures = []; let worker, detail;
  let courses = []; let scanned = 0;
  try {
    if (!xijiProxyUrl(page.url())) return { assignments: [], complete: false, authenticated: false, message: '请先登录学校 VPN 和希冀。' };
    worker = await context.newPage();
    detail = await context.newPage();
    await worker.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 45000 }); await waitForList(worker);
    let snapshot = await inspectXijiPage(worker);
    if (snapshot.login) return { assignments: [], complete: false, authenticated: false, message: '希冀需要登录或填写验证码。' };
    if (snapshot.links.length) {
      const first = xijiProxyUrl(snapshot.links[0].href, worker.url());
      if (first) { await worker.goto(first, { waitUntil: 'domcontentloaded' }); await waitForList(worker); snapshot = await inspectXijiPage(worker); }
    }
    courses = snapshot.courses;
    if (!snapshot.hasList || !courses.length) return { assignments: [], complete: false, authenticated: false, message: '希冀课程页未加载，请打开平台检查。' };
    for (const course of courses.slice(0, 60)) {
      await onProgress(`正在读取希冀「${course.name}」（${scanned + 1}/${courses.length}）`);
      try {
        snapshot = await inspectXijiPage(worker);
        if (snapshot.courses.find(c => c.selected)?.id !== course.id) {
          await worker.locator('#courseDropdown').click();
          const target = worker.locator(`.dropdown-item-course[value="${course.id}"]:visible`).first();
          await Promise.all([worker.waitForLoadState('load').catch(() => {}), target.click()]);
          await worker.waitForFunction(id => [...document.querySelectorAll('.dropdown-item-course.font-weight-bold')].some(e => e.getAttribute('value') === id), course.id, { timeout: 20000 });
          await waitForList(worker);
          snapshot = await inspectXijiPage(worker);
        }
        if (snapshot.login || !snapshot.hasList || snapshot.courses.find(c => c.selected)?.id !== course.id) throw new Error('课程主页未就绪');
        if (snapshot.pagination) failures.push(`${course.name}出现未适配分页`);
        for (const record of snapshot.cards) {
          const item = normalizeXijiCard(record, course);
          if (!item) { failures.push(`${course.name}存在未识别作业卡片`); continue; }
          await onProgress(`正在读取希冀「${item.title}」`);
          try {
            const result = await collectXijiDetails(detail, item);
            assignments.set(item.externalId, result);
            if (result.detailComplete === false) failures.push(`${item.title}部分题目个人提交记录读取失败`);
          } catch {
            failures.push(`${item.title}个人提交记录读取失败`);
            assignments.set(item.externalId, { ...item, status: 'unknown', kind: 'assignment', statusLabel: '个人提交记录读取失败', statusEvidence: '个人题目明细未读全，提交数待确认。请稍后重试。' });
          }
        }
        scanned++;
      } catch { failures.push(`${course.name}读取失败`); }
    }
    const complete = scanned === courses.length && failures.length === 0;
    return { assignments: [...assignments.values()], authenticated: true, complete,
      message: `课程 ${scanned}/${courses.length} 门，任务 ${assignments.size} 项。${complete ? '题目明细已读全。' : failures.join('；') + '。'}不含已关闭任务。` };
  } catch { return { assignments: [...assignments.values()], authenticated: scanned > 0, complete: false, message: `希冀读取中断，已保留 ${assignments.size} 项，请检查 VPN 登录状态。` }; }
  finally { await worker?.close().catch(() => {}); await detail?.close().catch(() => {}); }
}
