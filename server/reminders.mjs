import { createHash } from 'node:crypto';

const PLATFORMS = new Set(['chaoxing', 'yuketang', 'pta', 'xiji']);
const PLATFORM_NAMES = { chaoxing: '学习通', yuketang: '雨课堂', pta: 'PTA', xiji: '希冀平台' };
const INCOMPLETE = new Set(['pending', 'in_progress', 'overdue']);
const MINUTE = 60_000;

export const DEFAULT_EMAIL_SETTINGS = {
  enabled: false, host: '', port: 465, secure: true,
  username: '', from: '', to: '', freshnessMinutes: 120, rules: [],
  lastSentAt: null, lastTestAt: null, lastError: '',
};

function address(value) {
  return typeof value === 'string' && value.length <= 320
    && /^[^\s@,;<>\r\n]+@[^\s@,;<>\r\n]+\.[^\s@,;<>\r\n]+$/.test(value);
}

/** Validate user rules and set the earliest time newly activated rules can fire. */
export function normalizeEmailSettings(input, previous = DEFAULT_EMAIL_SETTINGS, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('邮件设置格式不正确。');
  const enabled = input.enabled;
  const secure = input.secure;
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const from = typeof input.from === 'string' ? input.from.trim() : '';
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const port = input.port;
  const freshnessMinutes = input.freshnessMinutes;
  if (typeof enabled !== 'boolean' || typeof secure !== 'boolean'
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(freshnessMinutes) || freshnessMinutes < 5 || freshnessMinutes > 1440) {
    throw new Error('邮件开关、端口或状态时效设置不正确。');
  }
  if (host && (host.length > 253 || !/^[a-z\d.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')))
    throw new Error('SMTP 主机只能填写主机名或 IP，不能包含网址或路径。');
  if (username.length > 320 || /[\r\n]/.test(username) || from && !address(from) || to && !address(to))
    throw new Error('邮箱账号或邮件地址格式不正确。');
  if (!Array.isArray(input.rules) || input.rules.length > 12) throw new Error('最多可设置 12 条提醒规则。');
  const seenIds = new Set();
  const seenRules = new Set();
  const previousRules = new Map((previous.rules || []).map(rule => [rule.id, rule]));
  const resetTime = !previous.enabled || previous.to !== to;
  const rules = input.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || typeof rule.id !== 'string' || !/^[a-z\d_-]{1,64}$/i.test(rule.id)
      || !['before', 'after'].includes(rule.kind)
      || !Number.isInteger(rule.minutes)
      || rule.minutes < (rule.kind === 'before' ? 1 : 0)
      || rule.minutes > (rule.kind === 'before' ? 525600 : 10080)
      || rule.platform !== 'all' && !PLATFORMS.has(rule.platform)) throw new Error('提醒规则格式不正确。');
    const signature = `${rule.kind}:${rule.minutes}:${rule.platform}`;
    if (seenIds.has(rule.id) || seenRules.has(signature)) throw new Error('提醒规则不能重复。');
    seenIds.add(rule.id); seenRules.add(signature);
    const old = previousRules.get(rule.id);
    const unchanged = old?.kind === rule.kind && old?.minutes === rule.minutes && old?.platform === rule.platform;
    // Saving unrelated SMTP fields must not silently re-arm old reminders.
    return { id: rule.id, kind: rule.kind, minutes: rule.minutes, platform: rule.platform,
      effectiveFrom: enabled && !resetTime && unchanged && Number.isFinite(Date.parse(old.effectiveFrom))
        ? old.effectiveFrom : new Date(now).toISOString() };
  });
  if (enabled && (!host || !username || !address(from) || !address(to) || !rules.length))
    throw new Error('启用邮件提醒前，请填写 SMTP、发件/收件地址并添加规则。');
  return { enabled, host, port, secure, username, from, to, freshnessMinutes, rules };
}

function deliveryKey(assignment, rule, recipient) {
  return createHash('sha256').update(JSON.stringify([
    assignment.id, assignment.dueAt, rule.id, rule.kind, rule.minutes, recipient,
  ])).digest('hex').slice(0, 32);
}

/** Only recently observed, explicitly unfinished cloud states may produce mail. */
export function dueReminderEvents(assignments, settings, sent = {}, now = Date.now()) {
  if (!settings?.enabled) return [];
  const events = [];
  for (const assignment of assignments || []) {
    if (!INCOMPLETE.has(assignment?.status) || assignment.sourceMissing || !assignment.dueAt) continue;
    const due = Date.parse(assignment.dueAt);
    const seen = Date.parse(assignment.lastSeenAt);
    if (!Number.isFinite(due) || !Number.isFinite(seen) || seen > now + MINUTE
      || now - seen > settings.freshnessMinutes * MINUTE) continue;
    for (const rule of settings.rules || []) {
      if (rule.platform !== 'all' && rule.platform !== assignment.platform) continue;
      const effectiveFrom = Date.parse(rule.effectiveFrom);
      if (!Number.isFinite(effectiveFrom)) continue;
      const trigger = due + (rule.kind === 'before' ? -rule.minutes : rule.minutes) * MINUTE;
      if (now < trigger || trigger < effectiveFrom) continue;
      if (rule.kind === 'before' && now >= due) continue;
      const key = deliveryKey(assignment, rule, settings.to);
      if (!sent[key]) events.push({ key, assignment, rule });
    }
  }
  return events.slice(0, 100);
}

const displayDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
function ruleLabel(rule) {
  const unit = rule.minutes && rule.minutes % 1440 === 0 ? 1440 : rule.minutes && rule.minutes % 60 === 0 ? 60 : 1;
  return `${rule.kind === 'before' ? '截止前' : '截止后'} ${rule.minutes / unit} ${unit === 1440 ? '天' : unit === 60 ? '小时' : '分钟'}`;
}

/** Plain text only; platform links may contain signed tokens, so omit them. */
export function buildReminderMessage(events) {
  const grouped = new Map();
  for (const event of events) {
    const id = event.assignment.id;
    if (!grouped.has(id)) grouped.set(id, { assignment: event.assignment, labels: [] });
    grouped.get(id).labels.push(ruleLabel(event.rule));
  }
  const lines = [`以下 ${grouped.size} 项作业在最近一次平台读取中尚未确认完成：`, ''];
  for (const [index, { assignment, labels }] of [...grouped.values()].entries()) {
    lines.push(`${index + 1}. [${PLATFORM_NAMES[assignment.platform] || clean(assignment.platform)}] ${clean(assignment.title)}`,
      `   课程：${clean(assignment.course)}`,
      `   截止：${assignment.dueAtEstimated ? '约 ' : ''}${displayDate.format(new Date(assignment.dueAt))}`,
      `   状态：${clean(assignment.statusLabel) || '平台尚未确认完成'}`,
      `   触发规则：${labels.join('、')}`,
      `   最近读取：${displayDate.format(new Date(assignment.lastSeenAt))}`, '');
  }
  lines.push('邮件仅依据最近一次读取结果；若刚提交作业，请重新同步后查看平台记录。');
  return { subject: `【作业提醒】${grouped.size} 项作业尚未确认完成`, text: lines.join('\n') };
}
