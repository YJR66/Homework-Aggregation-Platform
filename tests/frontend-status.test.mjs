import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual UI functions without opening a live service or a browser
// profile. The executable event wiring and polling are intentionally excluded.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const functionsEnd = source.indexOf("  $$('.primary-nav [data-view]')");
assert.ok(functionsEnd > 0, 'UI event-wiring boundary is present');
function ui() {
  const nodes = new Map();
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', innerHTML: '' });
    return nodes.get(selector);
  } };
  const api = vm.runInNewContext(`${source.slice(0, functionsEnd)}
    return { model, isComplete, isSubmitted, isPlatformComplete, isOverdue, isUnknown, describeDue, platformStatusLabel, progressLabel, assignmentMarkup, renderStats };
  })();`, { URL, Date, Intl, document });
  return { ...api, nodes };
}
const base = { id: 'one', platform: 'pta', title: '线性结构', course: '数据结构', status: 'pending', kind: 'assignment', url: 'https://pintia.cn/problem-sets/1/overview' };

test('login UI asks for credentials instead of offering a session-only verification button', () => {
  assert.match(source, /data-action="configure"[^>]*>\$\{icon\('link'\)\}账号密码登录/);
  assert.match(source, /data-action="authenticate"[^>]*>.*已保存账号登录/);
  assert.doesNotMatch(source, /data-action="verify"/);
  assert.match(pageSource, /id="credential-username"[^>]*required/);
  assert.match(pageSource, /id="credential-password"[^>]*required/);
  assert.match(pageSource, /id="credential-vpn-username"/);
  assert.match(pageSource, /id="credential-vpn-password"/);
  assert.match(pageSource, /id="save-credentials"[^>]*>保存并登录/);
  assert.doesNotMatch(pageSource, /id="credential-entry"/);
});

test('personal submission and progress labels appear with expandable visible evidence', () => {
  const { assignmentMarkup } = ui();
  const html = assignmentMarkup({ ...base, status: 'in_progress', statusLabel: '已完成 1/3 题', statusEvidence: '个人记录：A 已通过；B、C 未提交。', progress: { completed: 1, submitted: 1, total: 3, unit: '题' } });
  assert.match(html, /assignment-status in-progress">已完成 1\/3 题/);
  assert.match(html, /<details class="assignment-evidence"/);
  assert.match(html, /<p>个人记录：A 已通过；B、C 未提交。<\/p>/);
  assert.match(html, /已通过 1 \/ 3题 · 已提交 1 \/ 3题/);
  assert.doesNotMatch(html, /详情读取失败/);
});

test('material reading tasks remain actionable and do not imply written submission', () => {
  const api = ui();
  const item = { ...base, platform: 'yuketang', kind: 'material', status: 'in_progress', statusLabel: '阅读 1/2 页', statusEvidence: '课件学习进度 1/2 页。', progress: { completed: 1, total: 2, unit: '页' } };
  const html = api.assignmentMarkup(item);
  assert.equal(api.isComplete(item), false);
  assert.match(html, /学习资料 \/ 课件/);
  assert.match(html, /阅读 1\/2 页/);
  assert.match(html, /已阅读 1 \/ 2页/);
  assert.match(html, /<p>课件学习进度 1\/2 页。<\/p>/);
  assert.doesNotMatch(html, /evidence-scope|已提交 [0-9]/);
  assert.doesNotMatch(html, /无需|不需要完成|平台已提交|已提交 0/);
  assert.doesNotMatch(html.match(/<input[^>]+>/)[0], /disabled|checked/);
});

test('platform completed is archived without being renamed submitted', () => {
  const api = ui();
  const item = { ...base, status: 'completed' };
  assert.equal(api.isComplete(item), true);
  assert.equal(api.isPlatformComplete(item), true);
  assert.equal(api.isSubmitted(item), false);
  const html = api.assignmentMarkup(item);
  assert.match(html, /assignment-status complete">平台已完成/);
  assert.match(html.match(/<input[^>]+>/)[0], /checked[^>]*disabled/);
  assert.doesNotMatch(html, /平台已提交/);
  assert.match(api.assignmentMarkup({ ...base, status: 'submitted' }), /assignment-status complete">平台已提交/);
});

test('legacy local completion flag never archives an assignment without cloud evidence', () => {
  const api = ui();
  const item = { ...base, completed: true, statusLabel: '未开始', statusEvidence: '平台个人记录：尚未开始。' };
  assert.equal(api.isComplete(item), false);
  assert.equal(api.isPlatformComplete(item), false);
  const html = api.assignmentMarkup(item);
  assert.match(html, /assignment-status ">未开始/);
  assert.match(html, /平台个人记录：尚未开始。/);
  assert.match(html, /曾有本地完成标记，但未获云端确认；仍计入待完成/);
  const checkbox = html.match(/<input[^>]+>/)[0];
  assert.match(checkbox, /云端确认后完成/);
  assert.doesNotMatch(checkbox, /checked/);
  assert.doesNotMatch(checkbox, /disabled/);
});

test('pending checkbox is a cloud confirmation affordance, never a local completion control', () => {
  const { assignmentMarkup, isComplete } = ui();
  const html = assignmentMarkup({ ...base, status: 'in_progress', completed: false });
  const checkbox = html.match(/<input[^>]+>/)[0];
  assert.equal(isComplete({ ...base, status: 'in_progress', completed: true }), false);
  assert.match(checkbox, /aria-label="云端确认后完成：线性结构"/);
  assert.doesNotMatch(checkbox, /checked/);
  assert.match(html, /title="点击后先从云端重新读取；只有平台确认提交\/完成才会归入已完成"/);
  assert.match(pageSource, /<div class="list-footer"><span>完成状态以平台记录为准；勾选后重新核验<\/span>/);
  assert.doesNotMatch(html, /evidence-scope/);
});

test('unknown means detail read failure, never inferred unsubmitted or overdue', () => {
  const api = ui();
  const item = { ...base, status: 'unknown', statusLabel: '旧标签不能冒充已确认', dueAt: '2020-01-01T00:00:00Z' };
  assert.equal(api.isOverdue(item), false);
  assert.equal(api.describeDue(item).label, '截止已过');
  const html = api.assignmentMarkup(item);
  assert.match(html, /assignment-status unknown">详情读取失败/);
  assert.match(html, /未能读取个人完成详情，不代表未交/);
  assert.doesNotMatch(html, /旧标签不能冒充已确认|提交状态待确认|已逾期/);
  assert.match(api.assignmentMarkup({ ...item, completed: true }), /详情读取失败/);
});

test('proven incomplete homework does not hide incomplete per-question coverage', () => {
  const api = ui();
  const item = { ...base, platform: 'xiji', status: 'pending', detailComplete: false, statusLabel: '未完成（21 题明确未提交）', statusEvidence: '共22题，1题个人提交信息读取失败。', progress: { total: 22, unit: '题' } };
  const html = api.assignmentMarkup(item);
  assert.match(html, /未完成（21 题明确未提交）/);
  assert.match(html, /个别题目明细未读全/);
  assert.doesNotMatch(html, /已提交 0|0 \/ 22/);
  api.model.data = { assignments: [item] };
  api.renderStats();
  assert.match(api.nodes.get('.stat-pending .stat-caption').innerHTML, /1 项题目明细未读全/);
});

test('partial progress preserves zero and unknown total without inferring status', () => {
  const api = ui();
  assert.equal(api.progressLabel({ progress: { completed: 0, total: null, unit: '题' } }), '已完成 0题');
  assert.equal(api.progressLabel({ progress: { completed: 0, submitted: 0, total: 5, unit: '题' } }), '已完成 0 / 5题 · 已提交 0 / 5题');
  assert.equal(api.progressLabel({ progress: { completed: -1, submitted: '0', total: null } }), '');
  assert.equal(api.isComplete({ ...base, progress: { completed: 5, total: 5 } }), false);
  assert.equal(api.platformStatusLabel({ ...base, status: 'in_progress' }), '进行中');
});

test('status evidence is escaped, evidence expansion is preserved, and unsafe links are omitted', () => {
  const api = ui();
  const html = api.assignmentMarkup({ ...base, statusLabel: '<img src=x>', statusEvidence: '<script>alert(1)</script>', url: 'javascript:alert(1)', progress: { completed: 0, unit: '<img src=x>' } }, true);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-evidence-for="one" open/);
  assert.doesNotMatch(html, /<img|<script|javascript:/);
});

test('statistics include platform completion and explicitly label detail read failures', () => {
  const api = ui();
  api.model.data = { assignments: [
    { ...base, status: 'completed' }, { ...base, status: 'submitted' },
    { ...base, status: 'unknown', dueAt: '2020-01-01T00:00:00Z' },
    { ...base, status: 'in_progress' },
  ] };
  api.renderStats();
  assert.equal(api.nodes.get('#stat-pending').textContent, 2);
  assert.equal(api.nodes.get('#stat-completed').textContent, 2);
  assert.equal(api.nodes.get('#stat-overdue').textContent, 0);
  assert.match(api.nodes.get('.stat-pending .stat-caption').innerHTML, /含 1 项详情读取失败/);
  assert.doesNotMatch(api.nodes.get('.stat-pending .stat-caption').innerHTML, /待确认/);
});
