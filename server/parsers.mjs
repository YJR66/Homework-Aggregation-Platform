import { createHash } from 'node:crypto';

export const cleanText = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

function shanghaiParts(now) {
  const date = new Date(new Date(now).getTime() + 8 * 3600000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDate(year, month, day, hour = 23, minute = 59, second = 59) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return new Date(time - 8 * 3600000).toISOString();
}

/** Parse explicit deadlines as Asia/Shanghai, never as the host machine's timezone. */
export function parseDueAt(value, { now = new Date() } = {}) {
  const text = cleanText(value);
  if (!text || /不限时|无截止|无限期|长期有效|永久有效|未设置|待定/.test(text)) return null;
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/i);
  if (iso) {
    const [, year, month, day] = iso[1].match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!localDate(+year, +month, +day)) return null;
    const parsed = Date.parse(iso[1]);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const current = shanghaiParts(now);
  // When a range is present, use its final timestamp, not the release/start time.
  const matches = [...text.matchAll(/(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?:[T\s]*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?/g)];
  if (matches.length) {
    const [, y, m, d, hh, mm, ss] = matches.at(-1);
    return localDate(+y, +m, +d, hh === undefined ? 23 : +hh, mm === undefined ? 59 : +mm, ss === undefined ? (hh === undefined ? 59 : 0) : +ss);
  }
  const relative = text.match(/(今天|今日|明天|明日|后天|昨日|昨天)(?:\s*)(?:(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?/);
  if (relative) {
    const dayOffset = /明/.test(relative[1]) ? 1 : relative[1] === '后天' ? 2 : /昨/.test(relative[1]) ? -1 : 0;
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    return localDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), relative[2] === undefined ? 23 : +relative[2], relative[3] === undefined ? 59 : +relative[3], relative[4] === undefined ? (relative[2] === undefined ? 59 : 0) : +relative[4]);
  }
  const short = text.match(/(?:^|\D)(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?:[T\s]*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?(?!\d)/);
  if (short) return localDate(current.year, +short[1], +short[2], short[3] === undefined ? 23 : +short[3], short[4] === undefined ? 59 : +short[4], short[5] === undefined ? (short[3] === undefined ? 59 : 0) : +short[5]);
  return null;
}

export function extractDeadline(text) {
  const value = cleanText(text);
  // A published/start time without an end label is not a deadline.
  const label = /(?:截止(?:日期|时间)?|截至|结束(?:日期|时间)?|提交期限|有效期(?:至)?|到期(?:时间)?|deadline|due(?:\s+date)?|end\s+time)\s*[:：]?\s*/ig;
  const matches = [...value.matchAll(label)];
  if (!matches.length) return '';
  const start = matches.at(-1).index + matches.at(-1)[0].length;
  return value.slice(start, start + 100).split(/\n|(?:发布|开始|创建|提交)时间/)[0].trim();
}

/** Submission state wins over a passed deadline; “已截止” alone is not proof of non-submission. */
export function parseStatus(value, dueAt = null, { now = new Date() } = {}) {
  const text = cleanText(value);
  const pending = /未提交|未交(?:作业)?|待提交|待完成|待作答|未作答|未完成|未开始作答|重新提交|打回|退回|未通过|\bnot\s+submitted\b|\bpending\b/i.test(text);
  if (pending) return (dueAt && Date.parse(dueAt) < new Date(now).getTime()) || /已截止|已结束|已过期|逾期/.test(text) ? 'overdue' : 'pending';
  if (/已提交|已交(?:作业)?|已完成|已作答|已批阅|已批改|待批阅|待批改|批阅中|\bsubmitted\b|\bcompleted\b|\bgraded\b/i.test(text)) return 'submitted';
  return 'unknown';
}

export function safeHttpUrl(value, base) {
  if (!value || /^(?:javascript|data|file|mailto|tel):/i.test(String(value).trim())) return '';
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch { return ''; }
}

export function stableExternalId(platform, record) {
  const url = safeHttpUrl(record.url);
  if (record.id) return `${platform}:${String(record.id).slice(0, 200)}`;
  let identity = '';
  if (url) {
    const parsed = new URL(url);
    // Never store expiring signatures, usernames, or tokens in the hash identity.
    const ids = [...parsed.searchParams].filter(([key]) => /^(?:workId|homeworkId|assignmentId|taskId|problemSetId|id|courseId|clazzId)$/i.test(key));
    if (ids.length) identity = `${parsed.origin}${parsed.pathname}?${ids.sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
    else if (/\/(?:assignments?|homeworks?|problem-sets?|works?|tasks?)\/[^/?#]+/i.test(parsed.pathname)) identity = parsed.origin + parsed.pathname;
  }
  if (!identity) identity = `${cleanText(record.course)}\u0000${cleanText(record.title)}`;
  return `${platform}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

const NAVIGATION_TITLE = /^(?:作业|我的作业|作业列表|课程作业|课后作业|全部作业|课程|我的课程|我学的课|题目集|我的题目集|我的题库|题库|通知|公告|首页|更多|查看|进入|下一页|上一页|全部|未完成|已完成|未提交|已提交|操作|名称|标题|作业名称|作业标题|题目集名称)$/;

/** Reject vague cards: a course name plus a date is not an assignment. */
export function normalizeAssignment(record, { platform, course = '', now = new Date() } = {}) {
  const title = cleanText(record.title).replace(/\s*查看详情\s*$/, '').trim();
  if (title.length < 2 || title.length > 250 || NAVIGATION_TITLE.test(title)) return null;
  if (!record.assignmentEvidence || record.publicCatalog) return null;
  const text = cleanText(record.text);
  const deadlineText = record.dueText || extractDeadline(text);
  const dueAt = parseDueAt(deadlineText, { now });
  const status = parseStatus(record.statusText || text, dueAt, { now });
  // A heading/link called “作业” by itself must not become an assignment.
  if (!deadlineText && status === 'unknown' && !record.explicitAssignment) return null;
  const result = {
    title,
    course: cleanText(record.course || course) || '未识别课程',
    dueAt,
    status,
    url: safeHttpUrl(record.url, record.baseUrl),
  };
  result.externalId = stableExternalId(platform, { ...result, id: record.id });
  return result;
}

/** PTA's active-list cards show availability, not submission status. */
export function normalizePtaAssignment(record, { now = new Date() } = {}) {
  const title = cleanText(record.title);
  const url = safeHttpUrl(record.url, 'https://pintia.cn/');
  const match = url && new URL(url).pathname.match(/^\/problem-sets\/(\d+)\/overview\/?$/);
  if (!match || title.length < 2 || title.length > 250 || !record.personalList) return null;
  // A not-yet-open problem set cannot currently be worked on. Keep it out of actionable lists.
  if (/未开放|尚未开放/.test(record.availability || record.text || '')) return null;
  const closeText = cleanText(record.closeText);
  const deadline = /^\d{1,2}[:：]\d{2}(?:[:：]\d{2})?$/.test(closeText) ? `今天 ${closeText}` : closeText;
  return {
    externalId: `pta:${match[1]}`,
    title,
    course: cleanText(record.course) || 'PTA 题目集',
    dueAt: parseDueAt(deadline, { now }),
    // “已开放”, “已开考”, and score/ranking metadata cannot prove the user's submission.
    status: 'unknown',
    url,
  };
}
