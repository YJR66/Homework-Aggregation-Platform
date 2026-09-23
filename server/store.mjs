import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_EMAIL_SETTINGS } from './reminders.mjs';

export const DEFAULT_PLATFORMS = [
  { id: 'chaoxing', name: '学习通', entryUrl: 'https://i.chaoxing.com' },
  { id: 'yuketang', name: '雨课堂', entryUrl: 'https://www.yuketang.cn/web', syncUrl: 'https://www.yuketang.cn/v2/web/index' },
  { id: 'pta', name: 'PTA', entryUrl: 'https://pintia.cn/problem-sets', syncUrl: 'https://pintia.cn/problem-sets/active' },
  { id: 'xiji', name: '希冀平台', entryUrl: 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/indexcs/simple.jsp?loginErr=0', syncUrl: 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/main.jsp' },
];

export async function atomicWrite(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, filename);
  } finally {
    // Failed replacements must not leave additional copies of local work data.
    await unlink(tmp).catch(() => {});
  }
}

export function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}

export function assignmentId(platform, item) {
  const key = item.externalId || `${item.course || ''}\n${item.title}\n${safeUrl(item.url)}`;
  return createHash('sha256').update(`${platform}:${key}`).digest('hex').slice(0, 24);
}

export function safeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const field of ['completed', 'submitted', 'total']) {
    if (value[field] === null && field === 'total') output[field] = null;
    else if (Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= 1000000) output[field] = value[field];
  }
  if (!Object.keys(output).length) return null;
  output.unit = ['题', '页', '项'].includes(value.unit) ? value.unit : '项';
  return output;
}

function platformCompletion(status) { return status === 'submitted' || status === 'completed'; }

export class Store {
  constructor(dataDir) { this.filename = path.join(dataDir, 'state.json'); this.queue = Promise.resolve(); }
  async init() {
    let saved;
    try { saved = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('本地 state.json 无法读取；请先备份并检查文件，未覆盖原数据。'); }
    this.data = {
      version: 1, assignments: [], settings: { autoSync: true, syncIntervalMinutes: 30 }, ...saved,
      emailSettings: { ...DEFAULT_EMAIL_SETTINGS, ...saved?.emailSettings,
        rules: Array.isArray(saved?.emailSettings?.rules) ? saved.emailSettings.rules : [] },
      emailSent: saved?.emailSent && typeof saved.emailSent === 'object' && !Array.isArray(saved.emailSent) ? saved.emailSent : {},
      platforms: DEFAULT_PLATFORMS.map(p => {
        const old = saved?.platforms?.find(s => s.id === p.id);
        return { ...p, status: 'auth_required', message: '请登录后同步作业。', lastSyncAt: null, lastAttemptAt: null, assignmentCount: 0, ...old, authOpen: false,
          ...(old?.status === 'syncing' ? { status: 'auth_required', message: '上次同步已中断，请重新同步。' } : {}),
          ...(old?.loginStatus === 'authenticating' ? { loginStatus: 'unknown', authMessage: '上次登录验证已中断，请重新验证。' } : {}) };
      }),
    };
    // Local-only completion from an older version must not survive as a
    // completed task. Completion is now based on a confirmed platform state.
    this.data.assignments = this.data.assignments.map(item => item?.completed === true && !platformCompletion(item.status)
      ? { ...item, completed: false } : item);
    return this;
  }
  #mutate(change) {
    // Construct the next snapshot only after earlier writes finish. Readers keep
    // seeing the last committed state, including when encryption/disk I/O fails.
    this.queue = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.data);
      const result = change(next);
      if (result === false) return false;
      await atomicWrite(this.filename, JSON.stringify(next, null, 2));
      this.data = next;
      return result;
    });
    return this.queue;
  }
  // Public callers should use the mutation methods rather than changing data
  // before persist(); this still supports writing an unchanged initial state.
  persist() { return this.#mutate(() => {}); }
  platform(id) { return this.data.platforms.find(p => p.id === id); }
  async updatePlatform(id, patch) {
    const changes = structuredClone(patch);
    return this.#mutate(next => {
      const platform = next.platforms.find(p => p.id === id);
      if (!platform) throw new Error('未知平台。');
      Object.assign(platform, changes);
    });
  }
  async updateSettings(newSettings) {
    const changes = structuredClone(newSettings);
    return this.#mutate(next => {
      const settings = { ...next.settings, ...changes };
      if (typeof settings.autoSync !== 'boolean' || !Number.isInteger(settings.syncIntervalMinutes)
        || settings.syncIntervalMinutes < 5 || settings.syncIntervalMinutes > 1440) throw new Error('同步间隔须为 5～1440 分钟整数。');
      next.settings = settings;
    });
  }
  async updateEmailSettings(settings) {
    const changes = structuredClone(settings);
    return this.#mutate(next => { next.emailSettings = { ...next.emailSettings, ...changes, lastError: '' }; });
  }
  async updateEmailStatus(patch) {
    const changes = structuredClone(patch);
    return this.#mutate(next => {
      for (const key of ['lastSentAt', 'lastTestAt', 'lastError']) if (Object.hasOwn(changes, key)) next.emailSettings[key] = changes[key];
    });
  }
  async markEmailSent(keys, at) {
    const delivered = [...new Set(keys)];
    return this.#mutate(next => {
      for (const key of delivered) next.emailSent[key] = at;
      // Keep bounded delivery history across long-running installations.
      const entries = Object.entries(next.emailSent);
      if (entries.length > 5000) next.emailSent = Object.fromEntries(entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 4000));
      next.emailSettings.lastSentAt = at;
      next.emailSettings.lastError = '';
    });
  }
  async merge(platform, items, { complete = false } = {}) {
    const records = structuredClone(items);
    return this.#mutate(next => {
      const source = next.platforms.find(p => p.id === platform);
      if (!source) throw new Error('未知平台。');
      if (!Array.isArray(records)) throw new Error('作业列表格式不正确。');
      const now = new Date().toISOString();
      const seen = new Set();
      // Index the committed snapshot once: a full scan should be O(existing + incoming),
      // not one linear search of the whole assignment list per incoming row.
      const byId = new Map();
      for (const assignment of next.assignments) {
        if (!byId.has(assignment.id)) byId.set(assignment.id, assignment);
      }
      for (const item of records) {
        if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;
        const id = assignmentId(platform, item);
        seen.add(id);
        const existing = byId.get(id);
        const due = item.dueAt && Number.isFinite(Date.parse(item.dueAt)) ? new Date(item.dueAt).toISOString() : null;
        const status = ['pending', 'in_progress', 'submitted', 'completed', 'overdue', 'unknown'].includes(item.status) ? item.status : 'unknown';
        const record = {
          id, platform, title: item.title.slice(0, 500), course: String(item.course || '未识别课程').slice(0, 200),
          dueAt: due, status, url: safeUrl(item.url), externalId: String(item.externalId || '').slice(0, 500),
          kind: item.kind === 'material' ? 'material' : 'assignment',
          statusLabel: String(item.statusLabel || '').slice(0, 120),
          statusEvidence: String(item.statusEvidence || '').slice(0, 1200),
          detailComplete: typeof item.detailComplete === 'boolean' ? item.detailComplete : null,
          progress: safeProgress(item.progress),
          dueAtEstimated: Boolean(item.dueAtEstimated), dueText: String(item.dueText || '').slice(0, 200),
          sourceMissing: false,
          completed: platformCompletion(status) ? (existing?.completed ?? false) : false,
          firstSeenAt: existing?.firstSeenAt || now, lastSeenAt: now,
        };
        if (existing) Object.assign(existing, record);
        else { next.assignments.push(record); byId.set(id, record); }
      }
      // Missing rows are never deleted or silently marked complete: sources may paginate or fail.
      if (complete) for (const item of next.assignments) {
        if (item.platform === platform && !seen.has(item.id)) item.sourceMissing = true;
      }
      source.assignmentCount = next.assignments.filter(a => a.platform === platform).length;
    });
  }
  async complete(id, completed) {
    return this.#mutate(next => {
      const item = next.assignments.find(a => a.id === id);
      if (!item) return false;
      if (typeof completed !== 'boolean') throw new Error('完成状态必须是布尔值。');
      if (completed && !platformCompletion(item.status)) return false;
      item.completed = completed;
      return true;
    });
  }
}

function escapeIcs(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function icsDate(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function fold(line) {
  const out = []; let segment = '';
  for (const char of line) { if (Buffer.byteLength(segment + char) > 73) { out.push(segment); segment = ' '; } segment += char; }
  out.push(segment); return out.join('\r\n');
}
export function exportIcs(assignments) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Homework Hub//ZH', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:我的作业'];
  for (const a of assignments.filter(a => a.dueAt && Number.isFinite(Date.parse(a.dueAt)) && !a.completed && !['submitted', 'completed'].includes(a.status))) {
    lines.push('BEGIN:VEVENT', `UID:${a.id}@homework-hub.local`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(a.dueAt)}`, `SUMMARY:${escapeIcs(a.title)}`, `DESCRIPTION:${escapeIcs(`${a.course}\n${a.platform}\n${a.url}`)}`, 'END:VEVENT');
  }
  return [...lines, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
