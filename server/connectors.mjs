import { normalizePtaAssignment, safeHttpUrl } from './parsers.mjs';
import { collectChaoxingAssignments, CHAOXING_CAPABILITY } from './chaoxing.mjs';
import { collectXijiAssignments } from './xiji.mjs';
import { collectYuketangAssignments } from './yuketang.mjs';
import { enrichPtaAssignment } from './pta.mjs';
import { gotoReadOnly } from './navigation.mjs';

// Platform-specific read-only DOM routes observed with authenticated sessions on 2026-09-22.
// Completeness always refers to the documented scope of the individual collector.
export const CONNECTOR_CAPABILITIES = {
  chaoxing: CHAOXING_CAPABILITY,
  yuketang: { name: '雨课堂', mode: 'verified-student-unfinished-dom', verifiedAuthenticated: true, source: 'https://www.yuketang.cn/v2/web/index' },
  pta: { name: 'PTA', mode: 'verified-active-list', verifiedAuthenticated: true, source: 'https://pintia.cn/problem-sets/active' },
  xiji: { name: '希冀平台', mode: 'verified-webvpn-homework-dom', verifiedAuthenticated: true, source: 'https://vpn.neuq.edu.cn/' },
};

async function settled(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  // Do not require networkidle: the platforms have long-lived telemetry requests.
  await page.waitForTimeout(800);
}

/** Observed signed-in PTA DOM on 2026-09-22; overview details are read separately. */
export async function inspectPtaActivePage(page) {
  return page.evaluate(() => {
    const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const text = (el) => compact(el?.innerText || el?.textContent);
    const body = text(document.body);
    const loginVisible = [...document.querySelectorAll('input[type="password"],a,button')].some((el) => visible(el) && (el.matches('input[type="password"]') || /^(?:登录|登 录|立即登录)$/.test(text(el)))) || /请先登录|登录已过期|会话已过期/.test(body);
    const activeTab = document.querySelector('a#tab-active.active');
    const personalList = location.pathname === '/problem-sets/active' && visible(activeTab) && /活跃题目集/.test(text(activeTab));
    const rows = [...document.querySelectorAll('.pc-list > a[href]')].filter((el) => visible(el) && /^\/problem-sets\/\d+\/overview\/?$/.test(new URL(el.href).pathname));
    const records = rows.map((row) => {
      const rowText = text(row);
      const titleElement = [...row.querySelectorAll('div[title]')].find((el) => visible(el) && el.getAttribute('title'));
      const closing = [...row.querySelectorAll('div.flex.space-x-2')].find((el) => /^关闭时间\s*[:：]/.test(text(el)));
      const closingSpan = closing?.querySelector('span');
      const closeMatch = rowText.match(/关闭时间\s*[:：]\s*((?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s+)?\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)/);
      const statusLabels = [...row.querySelectorAll('span')].map(text).filter((value) => /^(?:已开放|未开放|尚未开放|已开考|未开考)$/.test(value));
      return { title: titleElement?.getAttribute('title') || '', url: row.href, text: rowText, closeText: text(closingSpan) || closeMatch?.[1] || '', availability: statusLabels.join(' '), personalList };
    });
    const pagination = [...document.querySelectorAll('[class*="paginationWrapper_"]')].find(visible);
    const summary = [...document.querySelectorAll('[class*="paginationSummary_"]')].find(visible);
    const totalMatch = text(summary).match(/共\s*([\d,]+)\s*条数据/);
    const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
    const controls = pagination ? [...pagination.querySelectorAll('button,a,[role="button"]')].filter(visible) : [];
    const next = controls.find((el) => {
      const label = [text(el), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('rel')].filter(Boolean).join(' ');
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /disabled/.test(el.className || '');
      return !disabled && /下一页|下页|\bnext\b|^(?:›|»|>)$/i.test(label);
    });
    return { loginVisible, personalList, records, total, next: next ? { text: text(next), label: next.getAttribute('aria-label') || '', title: next.getAttribute('title') || '', href: next.tagName === 'A' ? next.href : '' } : null };
  });
}

export async function collectPtaAssignments({ platform, context, page, onProgress = () => {} }) {
  const assignments = new Map();
  const seen = new Set();
  const notOpen = new Set();
  const maxPages = Math.min(Math.max(Number(platform.maxPages) || 40, 1), 100);
  let worker, detailPage;
  let total = null;
  let authenticated = false;
  let complete = false;
  let issue = '';
  let pagesRead = 0;
  try {
    // This is an observed, read-only personal-list route, not a guessed private API.
    worker = await context.newPage();
    await gotoReadOnly(worker, 'https://pintia.cn/problem-sets/active', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await worker.locator('a#tab-active.active, input[type="password"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await settled(worker);
    while (pagesRead < maxPages) {
      const snapshot = await inspectPtaActivePage(worker);
      if (snapshot.loginVisible) return { assignments: [...assignments.values()], authenticated: false, complete: false, message: 'PTA 登录已过期，请重新登录。' };
      if (!snapshot.personalList) { issue = '未识别到已登录的“活跃题目集”列表，页面可能已改版'; break; }
      authenticated = true;
      pagesRead++;
      if (snapshot.total !== null) {
        if (total !== null && total !== snapshot.total) { issue = '读取过程中题目集总数发生变化，请重新同步'; break; }
        total = snapshot.total;
      }
      const before = seen.size;
      for (const record of snapshot.records) {
        const id = record.url.match(/\/problem-sets\/(\d+)\/overview/)[1];
        seen.add(id);
        if (/未开放|尚未开放/.test(record.availability || record.text)) { notOpen.add(id); continue; }
        const item = normalizePtaAssignment(record);
        if (item) assignments.set(item.externalId, item);
        else issue = '部分题目集卡片缺少可识别的标题或链接';
      }
      try { onProgress(`PTA：题目集 ${seen.size}${total !== null ? `/${total}` : ''}`); } catch {}
      if (total !== null && seen.size === total && !issue) { complete = true; break; }
      if (total !== null && seen.size > total) { issue = '列表条数与页面总数不一致'; break; }
      if (pagesRead > 1 && seen.size === before) { issue = '下一页未发生变化，已停止重复读取'; break; }
      if (!snapshot.next) { issue ||= total === null ? '页面未显示可核对的题目集总数，无法确认是否完整' : `页面显示共 ${total} 项，仅识别 ${seen.size} 项，未找到可用的下一页`; break; }
      if (snapshot.next.href) {
        const nextUrl = safeHttpUrl(snapshot.next.href, worker.url());
        if (!nextUrl || new URL(nextUrl).hostname !== 'pintia.cn' || new URL(nextUrl).pathname !== '/problem-sets/active') { issue = '下一页链接不属于个人活跃列表，已停止读取'; break; }
      }
      const pagination = worker.locator('[class*="paginationWrapper_"]').first();
      let control;
      if (snapshot.next.label) control = pagination.getByRole('button', { name: snapshot.next.label, exact: true }).or(pagination.getByRole('link', { name: snapshot.next.label, exact: true }));
      else if (snapshot.next.title) control = pagination.getByTitle(snapshot.next.title, { exact: true });
      else if (snapshot.next.text) control = pagination.getByText(snapshot.next.text, { exact: true });
      else if (snapshot.next.href) control = pagination.locator('a[rel="next"]');
      if (!control || !await control.count()) { issue = '下一页控件无法安全定位'; break; }
      await control.first().click({ timeout: 5000 });
      await settled(worker);
    }
    if (!complete && pagesRead >= maxPages) issue = '已达到分页读取上限，请提高 maxPages 后重试';
    let verifiedDetails = 0;
    if (assignments.size) {
      detailPage = await context.newPage();
      for (const [externalId, item] of assignments) {
        try {
          onProgress(`PTA：正在读取「${item.title}」的答题记录`);
          const enriched = await enrichPtaAssignment(detailPage, item);
          assignments.set(externalId, enriched);
          if (enriched.status === 'unknown') { complete = false; issue = '部分题目集个人详情未读取完整，请重试'; }
          else verifiedDetails++;
        } catch {
          complete = false; issue = '部分题目集个人详情读取失败，请检查连接后重试';
          assignments.set(externalId, { ...item, kind: 'assignment', status: 'unknown', statusLabel: '详情读取失败', statusEvidence: '未取得个人概览或逐题提交记录，状态待确认。' });
        }
      }
    }
    const countNote = `活跃题目集 ${seen.size}${total !== null ? `/${total}` : ''}，已开放 ${assignments.size} 项${notOpen.size ? `，未开放 ${notOpen.size} 项` : ''}`;
    return {
      assignments: [...assignments.values()], authenticated, complete,
      message: `${countNote}；答题记录 ${verifiedDetails}/${assignments.size} 项。${complete ? '不含已关闭题目集。' : `${issue || '列表未读全'}。`}`,
    };
  } catch (error) {
    return { assignments: [...assignments.values()], authenticated, complete: false, message: `PTA 读取中断，保留 ${assignments.size} 项；${String(error?.message || '页面不可访问').slice(0, 160)}` };
  } finally { if (detailPage) await detailPage.close().catch(() => {}); if (worker) await worker.close().catch(() => {}); }
}

/** Use verified personal-list collectors; generic DOM cannot prove coverage. */
export async function collectAssignments({ platform, context, page, knownAssignments = [], onProgress = () => {} }) {
  if (!Object.hasOwn(CONNECTOR_CAPABILITIES, platform.id)) throw new Error(`不支持的平台：${platform.id}`);
  switch (platform.id) {
    case 'chaoxing':
      return collectChaoxingAssignments({ platform, context, page, onProgress });
    case 'yuketang':
      return collectYuketangAssignments({ platform, context, page, knownAssignments, onProgress });
    case 'pta':
      return collectPtaAssignments({ platform, context, page, onProgress });
    case 'xiji':
      return collectXijiAssignments({ platform, context, page, onProgress });
  }
}
