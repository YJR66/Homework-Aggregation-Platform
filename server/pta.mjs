import { gotoReadOnly } from './navigation.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Observed native read-only enum values. WRONG_ANSWER is still a submitted
// response, but must never be counted as correct.
const STATUS = new Set(['PROBLEM_ACCEPTED', 'PROBLEM_SUBMITTED', 'PROBLEM_WRONG_ANSWER', 'PROBLEM_NO_ANSWER']);
const integer = value => Number.isInteger(value) && value >= 0;

/** Only list-observed, read-only overview pages are accepted. */
export function ptaOverviewId(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://pintia.cn' || url.username || url.password || url.search || url.hash) return null;
    return url.pathname.match(/^\/problem-sets\/(\d+)\/(?:exam\/)?overview\/?$/)?.[1] || null;
  } catch { return null; }
}

/** Whitelist native GET responses; never request an exam-start or answer endpoint. */
export function ptaResponseKind(value, method, problemSetId) {
  try {
    const url = new URL(value);
    if (method !== 'GET' || url.origin !== 'https://pintia.cn' || url.username || url.password || url.search || url.hash || !/^\d+$/.test(problemSetId)) return null;
    if (url.pathname === `/api/problem-sets/${problemSetId}/exams`) return { kind: 'exam' };
    if (url.pathname === `/api/problem-sets/${problemSetId}/problem-summaries`) return { kind: 'summary' };
    const match = url.pathname.match(/^\/api\/exams\/(\d+)\/problem-sets\/(\d+)\/problem-status$/);
    if (match?.[2] === problemSetId) return { kind: 'problems', examId: match[1] };
    return null;
  } catch { return null; }
}

function unavailable(reason) {
  return { kind: 'assignment', status: 'unknown', statusLabel: '详情读取失败', statusEvidence: reason, detailComplete: false };
}

/** Summarize submission and correctness separately. No answers or user tokens are retained. */
export function normalizePtaDetail({ problemSetId, exam, summary, problems, problemExamId, body = '' } = {}) {
  if (!exam || String(exam.problemSetId) !== String(problemSetId)) return unavailable('PTA 未返回当前题目集的个人答题记录。');
  if (exam.state === 'READY' && !exam.examId && /未答题/.test(body)) {
    return {
      kind: 'assignment', status: 'pending', statusLabel: '未开始 · 未提交',
      progress: { completed: 0, submitted: 0, total: null, unit: '题' },
      statusEvidence: '个人概览显示“未答题”；答题记录为 READY，没有个人答题实例。',
      detailComplete: true,
    };
  }
  if (!exam.examId || String(problemExamId) !== String(exam.examId)) return unavailable('PTA 尚未返回与本人答题实例匹配的逐题提交状态。');
  if (!Array.isArray(summary) || !summary.length || summary.some(row => !integer(row.total))) return unavailable('PTA 题型总数未完整返回，不能核对逐题覆盖范围。');
  const total = summary.reduce((sum, row) => sum + row.total, 0);
  if (total < 1 || !Array.isArray(problems) || problems.length !== total || new Set(problems.map(row => row.id)).size !== total) return unavailable('PTA 逐题提交记录数量与题型总数不一致，本次详情不完整。');
  if (problems.some(row => !row.id || !STATUS.has(row.status))) return unavailable('PTA 返回了尚未识别的逐题状态，未擅自当作已提交或未提交。');
  const completed = problems.filter(row => row.status === 'PROBLEM_ACCEPTED').length;
  const submitted = problems.filter(row => row.status !== 'PROBLEM_NO_ANSWER').length;
  const programming = problems.filter(row => row.type === 'PROGRAMMING');
  const acceptedProgramming = programming.filter(row => row.status === 'PROBLEM_ACCEPTED').length;
  const objectiveSubmitted = problems.filter(row => row.type !== 'PROGRAMMING' && row.status === 'PROBLEM_SUBMITTED').length;
  const wrong = problems.filter(row => row.status === 'PROBLEM_WRONG_ANSWER').length;
  const needsExamSubmission = exam.allowSubmitExam === true && exam.ended === false;
  const status = submitted === total && !needsExamSubmission ? 'submitted' : 'in_progress';
  const remaining = total - submitted;
  return {
    kind: 'assignment', status,
    statusLabel: submitted === total
      ? (needsExamSubmission ? '已答完 · 尚未交卷' : `全部已提交${wrong ? ` · ${wrong} 题未通过` : ''}`)
      : `已提交 ${submitted}/${total} 题${wrong ? ` · ${wrong} 题未通过` : ''}`,
    progress: { completed, submitted, total, unit: '题' },
    statusEvidence: `逐题记录：已提交 ${submitted}/${total} 题，未提交 ${remaining} 题${wrong ? `，其中 ${wrong} 题判题未通过` : ''}${programming.length ? `；编程题通过 ${acceptedProgramming}/${programming.length} 题` : ''}${objectiveSubmitted ? `；${objectiveSubmitted} 道客观题已提交，不代表全部答对` : ''}${needsExamSubmission ? '；尚未交卷' : ''}。`,
    detailComplete: true,
  };
}

/**
 * Visiting a list's overview can redirect to /exam/overview even before starting.
 * These pages are read-only: listen to their native GET responses, never click
 * “开始答题”, “继续答题”, question links, or any submit button.
 */
export async function enrichPtaAssignment(page, assignment, { timeoutMs = 18000 } = {}) {
  const problemSetId = ptaOverviewId(assignment?.url);
  if (!problemSetId || assignment.externalId !== `pta:${problemSetId}`) throw new Error('PTA 详情链接不属于当前题目集的只读概览。');
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 18000, 1000), 60000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const jsonWithTimeout = async (response, ms) => {
    let timer;
    try {
      return await Promise.race([
        response.json(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PTA 原生响应读取超时。')), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  let lastDetail = unavailable('PTA 个人答题详情尚未返回。');
  let lastSnapshot = null;
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
    // Reserve half of the total budget for the one permitted reload. A slow
    // first SPA mount/JSON response must not consume both attempts' budgets.
    const attemptDeadline = attempt === 0 ? Date.now() + Math.floor(remaining() / 2) : deadline;
    const attemptRemaining = () => Math.max(1, attemptDeadline - Date.now());
    const snapshot = { problemSetId };
    const pending = new Set();
    let active = true;
    let revision = 0;
    let wake = null;
    const changed = () => { revision++; wake?.(); };
    const waitForChange = (observedRevision, ms) => new Promise(resolve => {
      if (!active || revision !== observedRevision || ms <= 0) return resolve();
      const finish = () => { clearTimeout(timer); if (wake === finish) wake = null; resolve(); };
      const timer = setTimeout(finish, ms);
      wake = finish;
    });
    const onResponse = response => {
      let route;
      try { route = ptaResponseKind(response.url(), response.request().method(), problemSetId); } catch { return; }
      if (!route || response.status() !== 200) return;
      const task = (async () => {
        let data;
        // A broken native response must not monopolize the entire enrichment
        // budget; leave room for the single bounded read-only reload.
        try { data = await jsonWithTimeout(response, Math.min(2000, attemptRemaining())); } catch { return; }
        if (!active || !data || typeof data !== 'object') return;
        if (route.kind === 'exam') {
          snapshot.exam = {
            problemSetId: data.problemSet?.id, state: data.status,
            examId: data.exam?.id, ended: data.exam?.ended,
            allowSubmitExam: data.problemSet?.problemSetConfig?.allowSubmitExam,
          };
          const due = data.exam?.endAt || data.problemSet?.endAt;
          if (typeof due === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(due) && Number.isFinite(Date.parse(due))) snapshot.dueAt = new Date(due).toISOString();
        } else if (route.kind === 'summary') {
          snapshot.summary = data.summaries && typeof data.summaries === 'object' ? Object.values(data.summaries).map(row => ({ total: row?.total })) : null;
        } else {
          snapshot.problemExamId = route.examId;
          snapshot.problems = Array.isArray(data.problemStatus) ? data.problemStatus.map(row => ({ id: row?.id, status: row?.problemSubmissionStatus, type: row?.problemType })) : null;
        }
      })().catch(() => {});
      pending.add(task);
      task.finally(() => { pending.delete(task); changed(); });
    };
    page.on('response', onResponse);
    try {
      await gotoReadOnly(page, assignment.url, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, attemptRemaining()) }, { maxAttempts: 1 });
      // The PTA overview is a SPA: navigation resolves before the exam app
      // mounts and starts its native GET requests. Waiting only for the
      // currently-known promises therefore races the page and produces a
      // false "missing personal record" result. Give the observed read-only
      // responses a bounded grace window, stopping as soon as all three
      // expected snapshots (exam, summary, problem status) arrive. A READY
      // instance with explicit "未答题" needs no summary/problem-status API:
      // the SPA does not issue them before the user starts answering.
      const responseUntil = Math.min(attemptDeadline, Date.now() + 6000);
      while (true) {
        const observedRevision = revision;
        snapshot.body = await page.locator('body').innerText({ timeout: Math.min(1000, attemptRemaining()) }).catch(() => '');
        if (snapshot.exam && snapshot.summary && Array.isArray(snapshot.problems)) break;
        if (snapshot.exam?.state === 'READY' && !snapshot.exam.examId && /未答题/.test(snapshot.body)) break;
        const wait = Math.min(200, responseUntil - Date.now());
        if (wait <= 0) break;
        // Native timers also work when browser mocks stub waitForTimeout; more
        // importantly, each parsed native response wakes this immediately.
        await waitForChange(observedRevision, wait);
      }
      await Promise.allSettled([...pending]);
      snapshot.body = await page.locator('body').innerText({ timeout: Math.min(1000, attemptRemaining()) }).catch(() => '');
      if (ptaOverviewId(page.url()) !== problemSetId) {
        if (/登录|验证码|安全验证/.test(snapshot.body)) throw new Error('PTA 详情需要重新登录或安全验证。');
        lastDetail = unavailable('PTA 未停留在当前题目集的个人概览页面。');
      } else {
        lastDetail = normalizePtaDetail(snapshot);
      }
      lastSnapshot = snapshot;
    } catch (error) {
      // Preserve the previous verified item on temporary navigation/response errors.
      if (/需要重新登录|安全验证/.test(String(error?.message || ''))) throw error;
      lastDetail = unavailable('PTA 个人答题详情暂时读取失败，请稍后重试。');
      lastSnapshot = snapshot;
    } finally {
      active = false;
      page.off('response', onResponse);
      wake?.();
      await Promise.allSettled([...pending]);
    }
    if (lastDetail.status !== 'unknown') return { ...assignment, ...lastDetail, ...(lastSnapshot?.dueAt ? { dueAt: lastSnapshot.dueAt, dueAtEstimated: false } : {}) };
    // An unfamiliar native status is deterministic, not a loading race. Only
    // missing/incomplete read-only data merits the one permitted reload.
    const unknownEnum = Array.isArray(lastSnapshot?.problems)
      && lastSnapshot.problems.some(row => row?.status && !STATUS.has(row.status));
    if (unknownEnum || attempt === 1 || Date.now() >= deadline) break;
    // Leave time for the second navigation even under a short caller budget.
    await delay(Math.min(250, Math.floor(remaining() / 4)));
  }
  return { ...assignment, ...lastDetail, ...(lastSnapshot?.dueAt ? { dueAt: lastSnapshot.dueAt, dueAtEstimated: false } : {}) };
}
