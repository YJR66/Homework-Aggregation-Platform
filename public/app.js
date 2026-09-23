(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const DAY = 86400000;
  const PLATFORM_META = {
    chaoxing: { name: '学习通', short: '学', color: '#bd8c65', background: '#fbf0e7' },
    yuketang: { name: '雨课堂', short: '雨', color: '#769abe', background: '#edf3fa' },
    pta: { name: 'PTA', short: 'PTA', color: '#92936b', background: '#f3f3e8' },
    xiji: { name: '希冀平台', short: '希', color: '#a48dbb', background: '#f2edf7' },
  };
  const STATUS_LABELS = {
    not_configured: '未配置', auth_required: '需要登录', awaiting_user: '等待验证',
    syncing: '正在同步', connected: '已连接', error: '同步失败', partial: '部分读取',
    idle: '等待同步', disconnected: '尚未连接',
  };
  const LOGIN_LABELS = {
    authenticated: '登录有效', expired: '登录已过期', challenge: '需要补充验证',
    unknown: '尚未验证登录', authenticating: '正在登录 / 验证', invalid_credentials: '账号或密码错误',
  };
  const model = {
    data: null, signature: '', loaded: false, refreshing: false,
    platform: null, tab: 'pending', due: 'all', search: '', sort: 'due',
    busy: new Set(), pendingAssignments: new Set(), hasSyncRequest: false,
  };
  let pollTimer;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function icon(name, className = '') {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }
  function safeUrl(value) {
    // Task links come from remote platforms; never render script or data URLs.
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  function asDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function dueTime(assignment) { return asDate(assignment.dueAt)?.getTime() ?? null; }
  function isSubmitted(assignment) { return assignment.status === 'submitted'; }
  function isPlatformComplete(assignment) { return isSubmitted(assignment) || assignment.status === 'completed'; }
  function isUnknown(assignment) { return !['pending', 'in_progress', 'submitted', 'completed', 'overdue'].includes(assignment.status); }
  // The legacy local `completed` flag is not proof of platform completion.
  function isComplete(assignment) { return isPlatformComplete(assignment); }
  function isOverdue(assignment) { const time = dueTime(assignment); return !isComplete(assignment) && !isUnknown(assignment) && time !== null && time < Date.now(); }
  function isUpcoming(assignment) { const time = dueTime(assignment); return !isComplete(assignment) && time !== null && time >= Date.now() && time <= Date.now() + 7 * DAY; }
  function formatDate(value, includeYear = false) {
    const date = asDate(value);
    if (!date) return '未提供截止时间';
    const showYear = includeYear || date.getFullYear() !== new Date().getFullYear();
    return new Intl.DateTimeFormat('zh-CN', { ...(showYear ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function relativeTime(value) {
    const date = asDate(value);
    if (!date) return '尚未同步';
    const elapsed = Math.max(0, Date.now() - date.getTime());
    if (elapsed < 60000) return '刚刚更新';
    if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前更新`;
    if (elapsed < DAY) return `${Math.floor(elapsed / 3600000)} 小时前更新`;
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日更新`;
  }
  function describeDue(assignment) {
    const due = dueTime(assignment);
    if (due === null) return { label: '未提供截止时间', className: '', absolute: '' };
    const difference = due - Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayDifference = Math.round((new Date(assignment.dueAt).setHours(0, 0, 0, 0) - today.getTime()) / DAY);
    let label;
    let className = '';
    if (!isComplete(assignment) && difference < 0) {
      const days = Math.floor(Math.abs(difference) / DAY);
      label = isUnknown(assignment) ? '截止已过' : days ? `已逾期 ${days} 天` : '已逾期';
      className = isUnknown(assignment) ? '' : 'overdue';
    } else {
      if (dayDifference === 0) label = '今天截止';
      else if (dayDifference === 1) label = '明天截止';
      else if (dayDifference > 1 && dayDifference <= 7) label = `${dayDifference} 天后截止`;
      else label = '截止于';
      if (!isComplete(assignment) && difference >= 0 && difference < 2 * DAY) className = 'soon';
    }
    if (isComplete(assignment)) label = '截止于';
    return { label, className, absolute: `${assignment.dueAtEstimated ? '约 ' : ''}${formatDate(assignment.dueAt)}` };
  }

  function platformStatusLabel(assignment) {
    if (isUnknown(assignment)) return '详情读取失败';
    const supplied = typeof assignment.statusLabel === 'string' ? assignment.statusLabel.trim() : '';
    return supplied || ({ submitted: '平台已提交', completed: '平台已完成', pending: '待完成', in_progress: '进行中', overdue: '逾期未完成' })[assignment.status];
  }
  function progressLabel(assignment) {
    const progress = assignment.progress;
    if (!progress || typeof progress !== 'object') return '';
    const count = (name) => Number.isSafeInteger(progress[name]) && progress[name] >= 0 ? progress[name] : null;
    const completed = count('completed'); const total = count('total'); const submitted = count('submitted');
    const denominator = total === null ? '' : ` / ${total}`;
    const unit = typeof progress.unit === 'string' ? progress.unit.trim().slice(0, 12) : '';
    // Present only numbers supplied by the collector; never infer task status.
    const completedLabel = assignment.kind === 'material' ? '已阅读' : assignment.platform === 'pta' ? '已通过' : '已完成';
    return [completed === null ? '' : `${completedLabel} ${completed}${denominator}${unit}`, submitted === null ? '' : `已提交 ${submitted}${denominator}${unit}`, completed === null && submitted === null && total !== null ? `总计 ${total}${unit}` : ''].filter(Boolean).join(' · ');
  }
  function assignmentMarkup(assignment, evidenceOpen = false) {
    const meta = PLATFORM_META[assignment.platform] || { name: assignment.platform || '其他平台', color: '#89997f', background: '#f1f5ec' };
    const complete = isComplete(assignment);
    const submitted = isSubmitted(assignment);
    const platformComplete = isPlatformComplete(assignment);
    const unknown = isUnknown(assignment);
    const partialDetails = assignment.detailComplete === false && !unknown;
    const due = describeDue(assignment);
    const dueTitle = assignment.dueAtEstimated && assignment.dueAt
      ? `预计截止：${formatDate(assignment.dueAt, true)}。根据平台${assignment.dueText ? `「${assignment.dueText}」` : '剩余时间'}估算，实际截止时间以原平台为准。`
      : assignment.dueAt ? formatDate(assignment.dueAt, true) : '源平台未提供截止时间';
    const url = safeUrl(assignment.url);
    const assignmentId = escapeHtml(assignment.id);
    const title = escapeHtml(assignment.title || '未命名任务');
    const checkboxLabel = submitted ? '平台已提交' : platformComplete ? '平台已完成' : '云端确认后完成';
    const kindLabel = assignment.kind === 'material' ? '学习资料 / 课件' : assignment.kind === 'assignment' ? '作业' : '';
    const evidence = typeof assignment.statusEvidence === 'string' && assignment.statusEvidence.trim() ? assignment.statusEvidence.trim() : '当前记录未附原平台详情依据。';
    const progress = progressLabel(assignment);
    const sourceMissingNote = (assignment.sourceMissing === true
      ? '<span class="assignment-status history-source-note" title="本轮未再显示，请到原平台确认。该任务作为历史记录保留，未自动标记完成。">本轮未再显示</span>' : '')
      + (partialDetails ? '<span class="assignment-status unknown">个别题目明细未读全</span>' : '');
    const legacyLocalNote = assignment.completed === true && !platformComplete
      ? '<p class="local-completion-note pending-confirmation">曾有本地完成标记，但未获云端确认；仍计入待完成。</p>' : '';
    const checkTitle = platformComplete ? `${checkboxLabel}，以平台记录为准` : '点击后先从云端重新读取；只有平台确认提交/完成才会归入已完成';
    return `<article class="assignment-row ${complete ? 'completed' : ''}" data-task-id="${assignmentId}"><label class="assignment-check" title="${checkTitle}"><input type="checkbox" data-assignment="${assignmentId}" aria-label="${checkboxLabel}：${title}" ${complete ? 'checked' : ''} ${platformComplete || model.pendingAssignments.has(String(assignment.id)) ? 'disabled' : ''}>${icon('check')}</label><div class="assignment-body"><div class="assignment-title-line"><span class="assignment-title">${title}</span>${url ? `<a class="assignment-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="在原平台打开" aria-label="在原平台打开：${title}">${icon('external')}</a>` : ''}</div><div class="assignment-meta"><span class="platform-badge" style="color:${meta.color};background:${meta.background}"><span class="platform-dot"></span>${escapeHtml(meta.name)}</span>${kindLabel ? `<span class="task-kind ${assignment.kind === 'material' ? 'material' : ''}">${kindLabel}</span>` : ''}<span class="course-name">${icon('book')}<span title="${escapeHtml(assignment.course || '未标注课程')}">${escapeHtml(assignment.course || '未标注课程')}</span></span>${sourceMissingNote}</div><div class="assignment-bottom"><span class="due-label ${due.className}" title="${escapeHtml(dueTitle)}">${icon('clock')}${escapeHtml(due.label)}${due.absolute ? `<span class="due-absolute">${escapeHtml(due.absolute)}</span>` : ''}</span><span class="assignment-status ${platformComplete ? 'complete' : unknown ? 'unknown' : assignment.status === 'in_progress' ? 'in-progress' : isOverdue(assignment) ? 'overdue' : ''}">${escapeHtml(platformStatusLabel(assignment))}</span></div>${unknown ? '<p class="status-read-failure">未能读取个人完成详情，不代表未交；请重试同步或查看原平台。</p>' : ''}${legacyLocalNote}<details class="assignment-evidence" data-evidence-for="${assignmentId}" ${evidenceOpen ? 'open' : ''}><summary>状态依据${progress ? ` · ${escapeHtml(progress)}` : ''}</summary><div class="evidence-content"><p>${escapeHtml(evidence)}</p></div></details></div></article>`;
  }

  async function api(path, options = {}) {
    // Keep every UI request bounded; a hung local service must not freeze actions.
    const controller = new AbortController();
    const { timeoutMs = 30000, ...requestOptions } = options;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { ...requestOptions, headers: { ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}), ...requestOptions.headers }, cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error?.message || body.error || body.message || `请求失败（${response.status}）`);
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请稍后再试。');
      if (error instanceof TypeError) throw new Error('暂时无法连接本地服务，请确认应用仍在运行。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function toast(message, type = 'success', duration = 6500) {
    const element = document.createElement('div');
    element.className = `toast ${type === 'error' ? 'error' : ''}`;
    element.innerHTML = `${icon(type === 'error' ? 'warning' : 'check')}<span>${escapeHtml(message)}</span><button class="icon-button" aria-label="关闭提示">${icon('close')}</button>`;
    $('#toasts').append(element);
    element.querySelector('button').addEventListener('click', () => element.remove());
    setTimeout(() => element.remove(), duration);
    while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  }
  function getPlatforms() {
    return Object.entries(PLATFORM_META).map(([id, meta]) => ({ id, name: meta.name, status: 'not_configured', configured: false, ...(model.data?.platforms || []).find((platform) => platform.id === id) }));
  }
  function getPlatform(id) { return getPlatforms().find((platform) => platform.id === id); }
  function assignments() { return Array.isArray(model.data?.assignments) ? model.data.assignments : []; }
  function loginJobs() { return Array.isArray(model.data?.sync?.loginPlatforms) ? model.data.sync.loginPlatforms : []; }
  function platformBusy(platform) {
    return model.busy.size > 0 || loginJobs().length > 0 || platform.loginStatus === 'authenticating'
      || platform.status === 'syncing' || Boolean(model.data?.sync?.running);
  }

  async function refresh(force = false) {
    if (model.refreshing) return;
    model.refreshing = true;
    try {
      const data = await api('/api/state');
      if (!Array.isArray(data.assignments) || !Array.isArray(data.platforms)) throw new Error('本地服务返回的数据格式不正确，请重新启动应用。');
      // The minute bucket refreshes relative timestamps even when state is unchanged.
      const signature = JSON.stringify(data) + Math.floor(Date.now() / 60000);
      const changed = signature !== model.signature || force;
      model.data = data;
      model.loaded = true;
      model.signature = signature;
      $('#connection-error').hidden = true;
      if (changed) render();
    } catch (error) {
      $('#connection-error').hidden = false;
      $('#connection-error-text').textContent = error.message;
      if (!model.loaded) renderOffline();
    } finally {
      model.refreshing = false;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(refresh, document.hidden ? 30000 : model.data?.sync?.running || loginJobs().length ? 2500 : 10000);
    }
  }

  function render() {
    renderNavigation();
    renderStats();
    renderPlatforms();
    renderAssignments();
    renderSync();
  }
  function renderNavigation() {
    const counts = { pending: 0, upcoming: 0, completed: 0, byPlatform: {} };
    for (const assignment of assignments()) {
      if (isComplete(assignment)) counts.completed++;
      else {
        counts.pending++;
        counts.byPlatform[assignment.platform] = (counts.byPlatform[assignment.platform] || 0) + 1;
      }
      if (isUpcoming(assignment)) counts.upcoming++;
    }
    $('#nav-all-count').textContent = counts.pending;
    $('#nav-upcoming-count').textContent = counts.upcoming;
    $('#nav-completed-count').textContent = counts.completed;
    $('#platform-nav').innerHTML = getPlatforms().map((platform) => {
      const meta = PLATFORM_META[platform.id];
      const count = counts.byPlatform[platform.id] || 0;
      return `<button class="nav-item ${model.platform === platform.id ? 'active' : ''}" data-platform-filter="${escapeHtml(platform.id)}" aria-pressed="${model.platform === platform.id}"><span class="platform-dot" style="background:${meta.color}"></span><span>${escapeHtml(meta.name)}</span><span class="platform-count">${count}</span></button>`;
    }).join('');
    const email = model.data?.emailSettings;
    $('#email-nav-status').textContent = email?.lastError ? '失败' : email?.enabled ? '已启用' : '';
    $$('.primary-nav .nav-item').forEach((button) => {
      const selected = !model.platform && (model.tab === 'completed' ? button.dataset.view === 'completed' : model.due === 'upcoming' ? button.dataset.view === 'upcoming' : button.dataset.view === 'all');
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const view = model.tab === 'completed' ? '已完成' : model.due === 'upcoming' ? '即将截止' : model.due === 'overdue' ? '已逾期' : '作业总览';
    const scope = model.platform ? `${PLATFORM_META[model.platform].name} · ` : '';
    $('#page-title').textContent = `${scope}${view}`;
    $('#breadcrumb-view').textContent = model.platform ? PLATFORM_META[model.platform].name : view;
    $('#page-description').textContent = model.tab === 'completed'
      ? '仅显示平台确认已提交或已完成的任务。'
      : model.due === 'upcoming' ? '显示未来 7 天内截止的未完成任务。'
        : model.due === 'overdue' ? '显示已过截止时间的未完成任务。'
          : model.platform ? `显示${PLATFORM_META[model.platform].name}的当前作业和学习任务。` : '汇总四个平台的当前作业和学习任务。';
  }
  function renderStats() {
    const list = assignments();
    const counts = { pending: 0, upcoming: 0, overdue: 0, completed: 0, unknown: 0, partial: 0 };
    for (const assignment of list) {
      if (isComplete(assignment)) counts.completed++;
      else {
        counts.pending++;
        if (isUnknown(assignment)) counts.unknown++;
        else if (assignment.detailComplete === false) counts.partial++;
      }
      if (isUpcoming(assignment)) counts.upcoming++;
      if (isOverdue(assignment)) counts.overdue++;
    }
    const notes = [counts.unknown ? `${counts.unknown} 项详情读取失败` : '', counts.partial ? `${counts.partial} 项题目明细未读全` : ''].filter(Boolean);
    $('#stat-pending').textContent = counts.pending;
    $('.stat-pending .stat-caption').innerHTML = escapeHtml(notes.length ? `含 ${notes.join('，')}` : counts.pending ? '平台尚未确认完成' : '暂无待完成任务');
    $('#stat-upcoming').textContent = counts.upcoming;
    $('#stat-overdue').textContent = counts.overdue;
    $('#stat-completed').textContent = counts.completed;
  }
  function renderPlatforms() {
    const platforms = getPlatforms();
    const activeElement = document.activeElement;
    const focusTarget = activeElement?.closest('#platform-cards button') ? { action: activeElement.dataset.action, platform: activeElement.dataset.platform } : null;
    $('#connection-count').textContent = `${platforms.filter((platform) => platform.loginStatus === 'authenticated').length} / 4`;
    $('#connection-count').title = '最近一次验证中，登录有效的平台数量；与作业采集结果独立';
    const ocrAvailable = model.data?.capabilities?.ocrAvailable === true;
    $('#ocr-status').textContent = ocrAvailable ? '本地 OCR 可用 · 支持希冀图片验证码' : '本地 OCR 未安装 · 图片验证码需手动填写';
    $('#ocr-status').classList.toggle('available', ocrAvailable);
    $('#ocr-status').title = ocrAvailable ? '验证码图片只在本机内存中识别，不上传；不包含短信、扫码、滑块或点选验证。' : '可在项目目录运行 npm run setup:ocr 安装本地识别组件；详见 README。';
    $('#platform-cards').innerHTML = platforms.map((platform) => {
      const meta = PLATFORM_META[platform.id];
      const status = platform.status || (platform.configured ? 'auth_required' : 'not_configured');
      const loginStatus = Object.hasOwn(LOGIN_LABELS, platform.loginStatus) ? platform.loginStatus : 'unknown';
      const authBusy = loginJobs().includes(platform.id) || loginStatus === 'authenticating';
      const busy = platformBusy(platform);
      const disabled = busy ? 'disabled' : '';
      let actions;
      if (!platform.configured) {
        actions = `<button class="button small secondary" data-action="configure" data-platform="${platform.id}" ${disabled}>${icon('link')}账号密码登录</button>`;
      } else {
        actions = `<button class="button small secondary" data-action="configure" data-platform="${platform.id}" ${disabled}>${icon('link')}账号密码登录</button><button class="button small subtle" data-action="authenticate" data-platform="${platform.id}" ${disabled}>${authBusy ? '<span class="spinner"></span>' : icon('shield')}${authBusy ? '正在登录…' : '已保存账号登录'}</button><button class="button small subtle" data-action="login" data-platform="${platform.id}" ${disabled}>${icon('external')}${platform.authOpen ? '查看辅助窗口' : '人工辅助'}</button><button class="button small subtle" data-action="collect" data-platform="${platform.id}" ${disabled}>${status === 'syncing' ? '<span class="spinner"></span>' : icon('refresh')}读取作业</button>`;
      }
      const authMessage = platform.authMessage || (!platform.configured ? '填写账号密码后自动登录，成功后读取作业。' : loginStatus === 'unknown' ? '可填写账号密码登录，或使用本机已保存的账号。' : '');
      const authCheck = asDate(platform.lastAuthCheckAt);
      const message = platform.message || (status === 'connected' ? `已读取 ${platform.assignmentCount ?? assignments().filter((assignment) => assignment.platform === platform.id).length} 项任务` : status === 'partial' ? '部分任务未能读取' : status === 'error' ? '作业读取失败' : status === 'auth_required' ? '请先登录' : '尚未读取作业');
      return `<article class="platform-card"><div class="platform-card-top"><span class="platform-logo ${platform.id}" style="background:${meta.background};color:${meta.color}">${meta.short}</span><div class="platform-info"><span class="platform-name">${escapeHtml(meta.name)}</span></div><button class="icon-button" title="填写${escapeHtml(meta.name)}账号密码" aria-label="填写${escapeHtml(meta.name)}账号密码" data-action="configure" data-platform="${platform.id}" ${disabled}>${icon('settings')}</button></div><div class="platform-auth-block"><span class="platform-login-state ${loginStatus}">${authBusy ? '<span class="spinner"></span>' : '<span class="status-dot"></span>'}${escapeHtml(LOGIN_LABELS[loginStatus])}</span><span class="auth-check-time">验证时间：${authCheck ? `<time datetime="${authCheck.toISOString()}">${escapeHtml(formatDate(authCheck))}</time>` : '尚未验证'}</span>${authMessage ? `<p class="platform-auth-message">${escapeHtml(authMessage)}</p>` : ''}</div><span class="platform-state ${escapeHtml(status)}"><span class="status-dot"></span>作业采集：${escapeHtml(STATUS_LABELS[status] || '等待同步')}${platform.lastSyncAt ? ` · ${escapeHtml(relativeTime(platform.lastSyncAt))}` : ''}</span>${message ? `<p class="platform-message ${status === 'error' ? 'error' : ''}">${escapeHtml(message)}</p>` : ''}<div class="platform-actions">${actions}</div></article>`;
    }).join('');
    if (focusTarget) {
      $$('#platform-cards button').find((button) => button.dataset.action === focusTarget.action && button.dataset.platform === focusTarget.platform)?.focus({ preventScroll: true });
    }
  }
  function renderSync() {
    const running = Boolean(model.data?.sync?.running || model.hasSyncRequest);
    const authenticating = loginJobs().length > 0;
    $('#sync-all').disabled = running || authenticating || model.busy.size > 0;
    $('#sync-all .icon').classList.toggle('spinning', running);
    $('#sync-all span').textContent = running ? '正在同步…' : authenticating ? '正在登录…' : '同步全部作业';
    $('#sync-banner').hidden = !running && !authenticating;
    const platformName = PLATFORM_META[model.data?.sync?.platformId]?.name;
    const platformIds = Array.isArray(model.data?.sync?.platformIds) ? model.data.sync.platformIds : [];
    const parallelMessage = platformIds.length > 1 ? `正在同步 ${platformIds.length} 个平台…` : null;
    $('#sync-message').textContent = !running && authenticating ? '正在登录平台账号…' : parallelMessage || (platformName ? `正在读取${platformName}作业…` : '正在读取各平台作业…');
    const dates = getPlatforms().map((platform) => asDate(platform.lastSyncAt)).filter(Boolean);
    $('#list-update-time').textContent = dates.length ? relativeTime(new Date(Math.max(...dates.map(Number)))) : '尚未同步';
  }
  function renderAssignments() {
    const base = assignments().filter((assignment) => !model.platform || assignment.platform === model.platform);
    $('#tab-pending-count').textContent = base.filter((assignment) => !isComplete(assignment)).length;
    $('#tab-completed-count').textContent = base.filter(isComplete).length;
    $$('.list-tab').forEach((button) => {
      const active = button.dataset.tab === model.tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('#due-filter').value = model.due;
    $('#sort-order').value = model.sort;
    const query = model.search.toLocaleLowerCase().trim();
    const list = base.filter((assignment) => {
      if (model.tab === 'pending' && isComplete(assignment)) return false;
      if (model.tab === 'completed' && !isComplete(assignment)) return false;
      if (model.due === 'upcoming' && !isUpcoming(assignment)) return false;
      if (model.due === 'overdue' && !isOverdue(assignment)) return false;
      if (model.due === 'undated' && dueTime(assignment) !== null) return false;
      return !query || [assignment.title, assignment.course, PLATFORM_META[assignment.platform]?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
    });
    list.sort((a, b) => {
      if (model.sort === 'newest') return (asDate(b.firstSeenAt)?.getTime() || 0) - (asDate(a.firstSeenAt)?.getTime() || 0);
      if (model.sort === 'course') return String(a.course || '未标注课程').localeCompare(String(b.course || '未标注课程'), 'zh-CN') || String(a.title).localeCompare(String(b.title), 'zh-CN');
      const aDue = dueTime(a); const bDue = dueTime(b);
      if (aDue === null && bDue === null) return String(a.title).localeCompare(String(b.title), 'zh-CN');
      if (aDue === null) return 1;
      if (bDue === null) return -1;
      return aDue - bDue;
    });
    $('#result-count').textContent = `${list.length} 项`;
    const filters = [model.platform ? PLATFORM_META[model.platform].name : '', model.due !== 'all' ? $('#due-filter').selectedOptions[0].textContent : '', query ? `搜索「${model.search}」` : ''].filter(Boolean);
    $('#filter-summary').hidden = filters.length === 0;
    $('#filter-summary-text').textContent = filters.join(' · ');
    if (!list.length) { renderEmpty(); return; }
    const focusId = document.activeElement?.dataset.assignment;
    // Re-rendered rows must keep the user's expanded evidence and keyboard focus.
    const openedEvidence = new Set($$('#assignments-list details[open]').map((element) => element.dataset.evidenceFor));
    $('#assignments-list').innerHTML = list.map((assignment) => assignmentMarkup(assignment, openedEvidence.has(String(assignment.id)))).join('');
    if (focusId) $$('#assignments-list input').find((input) => input.dataset.assignment === focusId)?.focus({ preventScroll: true });
  }
  function renderEmpty() {
    const anyData = assignments().length > 0;
    const anyConnected = getPlatforms().some((platform) => platform.status === 'connected' || platform.status === 'partial');
    const hasFilter = model.platform || model.due !== 'all' || model.search.trim();
    let title = '尚无作业记录';
    let description = '请先配置课程平台账号。登录成功后会自动同步作业。';
    let action = '<button class="button secondary" data-empty-action="connect">配置平台账号</button>';
    if (hasFilter) {
      title = '没有符合条件的任务';
      description = '请调整关键词或筛选条件。';
      action = '<button class="button secondary" data-empty-action="clear">清除筛选</button>';
    } else if (model.tab === 'completed') {
      title = '暂无已完成任务';
      description = '平台确认已提交或已完成后，任务会显示在这里。';
      action = '<button class="button secondary" data-empty-action="pending">查看待完成任务</button>';
    } else if (anyData && model.tab === 'pending') {
      title = '暂无待完成任务';
      description = '当前收录的任务均已由平台确认完成。';
      action = '<button class="button secondary" data-empty-action="all">查看全部任务</button>';
    } else if (anyConnected) {
      title = '本次未读取到任务';
      description = '请检查原平台是否已发布作业，或重新同步。';
      action = '<button class="button secondary" data-empty-action="sync">' + icon('refresh') + ' 重新同步</button>';
    }
    $('#assignments-list').innerHTML = `<div class="empty-state"><h3>${title}</h3><p>${description}</p>${action}</div>`;
  }
  function renderOffline() {
    $('#assignments-list').innerHTML = `<div class="empty-state"><h3>本地服务未连接</h3><p>请确认应用已启动。连接恢复后将自动加载清单。</p><button class="button secondary" data-empty-action="retry">${icon('refresh')}重新连接</button></div>`;
    $('#sync-all').disabled = true;
  }

  function changeView(view) {
    model.platform = null;
    model.tab = view === 'completed' ? 'completed' : 'pending';
    model.due = ['upcoming', 'overdue'].includes(view) ? view : 'all';
    model.search = '';
    $('#search').value = '';
    render();
    closeSidebar();
  }
  function clearFilters() {
    model.platform = null;
    model.due = 'all';
    model.search = '';
    $('#search').value = '';
    render();
  }
  function closeSidebar() {
    const wasOpen = $('#sidebar').classList.contains('open');
    $('#sidebar').classList.remove('open');
    $('#sidebar-backdrop').hidden = true;
    $('#mobile-menu').setAttribute('aria-expanded', 'false');
    $('#sidebar').inert = window.matchMedia('(max-width: 760px)').matches;
    if (wasOpen && $('#sidebar').inert) $('#mobile-menu').focus({ preventScroll: true });
  }
  function openCredentials(platformId) {
    const platform = getPlatform(platformId);
    if (!platform) return;
    $('#credentials-form').reset();
    $('#credentials-error').hidden = true;
    $('#credential-platform').value = platformId;
    $('#credentials-title').textContent = `登录${PLATFORM_META[platformId].name}`;
    $('#credentials-description').textContent = `${platformId === 'xiji' ? '请填写希冀平台和学校统一身份认证的两组账号密码。' : '请填写平台账号和密码。'}保存后自动登录，成功后读取作业；已有有效会话会复用。`;
    $('#vpn-fields').hidden = platformId !== 'xiji';
    $('#credential-vpn-username').required = platformId === 'xiji';
    $('#credential-vpn-password').required = platformId === 'xiji';
    $('#xiji-captcha-note').hidden = platformId !== 'xiji';
    $('#credentials-dialog').showModal();
    $('#credential-username').focus();
  }
  function openSettings() {
    $('#auto-sync').checked = model.data?.settings?.autoSync ?? false;
    $('#sync-interval').value = model.data?.settings?.syncIntervalMinutes ?? 30;
    $('#settings-error').hidden = true;
    $('#settings-dialog').showModal();
    closeSidebar();
  }
  function emailRuleMarkup(rule) {
    const unit = rule.minutes && rule.minutes % 1440 === 0 ? 1440 : rule.minutes && rule.minutes % 60 === 0 ? 60 : 1;
    const amount = rule.minutes / unit;
    const selected = (value, current) => value === current ? 'selected' : '';
    return `<div class="email-rule" data-rule-id="${escapeHtml(rule.id)}"><label>发送时间<select data-mail-rule="kind"><option value="before" ${selected('before', rule.kind)}>截止前</option><option value="after" ${selected('after', rule.kind)}>截止后</option></select></label><label>间隔<input data-mail-rule="amount" type="number" min="0" max="525600" step="1" required value="${amount}"></label><label>单位<select data-mail-rule="unit"><option value="1" ${selected(1, unit)}>分钟</option><option value="60" ${selected(60, unit)}>小时</option><option value="1440" ${selected(1440, unit)}>天</option></select></label><label>平台<select data-mail-rule="platform"><option value="all" ${selected('all', rule.platform)}>全部平台</option>${Object.entries(PLATFORM_META).map(([id, meta]) => `<option value="${id}" ${selected(id, rule.platform)}>${meta.name}</option>`).join('')}</select></label><button class="icon-button email-rule-remove" type="button" data-remove-email-rule aria-label="删除提醒规则">${icon('close')}</button></div>`;
  }
  function renderEmailRules(rules) {
    $('#email-rules').innerHTML = rules.length ? rules.map(emailRuleMarkup).join('') : '<p class="email-rules-empty">尚未添加规则。启用前请至少添加一条。</p>';
  }
  function openEmailSettings() {
    const settings = model.data?.emailSettings || {};
    $('#email-form').reset();
    $('#email-error').hidden = true;
    $('#email-enabled').checked = settings.enabled === true;
    $('#email-host').value = settings.host || '';
    $('#email-port').value = settings.port || 465;
    $('#email-security').value = settings.secure === false ? 'starttls' : 'ssl';
    $('#email-username').value = settings.username || '';
    $('#email-password').value = '';
    $('#email-password').placeholder = settings.passwordConfigured ? '留空沿用已保存密码' : '请输入密码或授权码';
    $('#email-from').value = settings.from || '';
    $('#email-to').value = settings.to || '';
    $('#email-freshness').value = settings.freshnessMinutes || 120;
    $('#test-email').disabled = !settings.passwordConfigured || settings.sending === true;
    const status = [settings.lastSentAt ? `上次提醒：${formatDate(settings.lastSentAt)}` : '',
      settings.lastTestAt ? `上次测试：${formatDate(settings.lastTestAt)}` : '', settings.lastError || ''].filter(Boolean);
    $('#email-delivery-status').textContent = status.join(' · ');
    renderEmailRules(Array.isArray(settings.rules) ? settings.rules : []);
    $('#email-dialog').showModal();
    closeSidebar();
  }
  function collectEmailRules() {
    return $$('#email-rules .email-rule').map((row) => {
      const amount = Number(row.querySelector('[data-mail-rule="amount"]').value);
      const unit = Number(row.querySelector('[data-mail-rule="unit"]').value);
      if (!Number.isInteger(amount) || amount < 0 || ![1, 60, 1440].includes(unit)) throw new Error('提醒时间须为非负整数。');
      return { id: row.dataset.ruleId, kind: row.querySelector('[data-mail-rule="kind"]').value,
        minutes: amount * unit, platform: row.querySelector('[data-mail-rule="platform"]').value };
    });
  }
  async function platformAction(platformId, action) {
    const platform = getPlatform(platformId);
    if (!platform || platformBusy(platform)) return;
    if (action === 'configure') { openCredentials(platformId); return; }
    if (!platform.configured) { openCredentials(platformId); return; }
    model.busy.add(platformId);
    renderPlatforms();
    renderSync();
    try {
      await api(`/api/platforms/${encodeURIComponent(platformId)}/${action}`, { method: 'POST', body: '{}' });
      const name = PLATFORM_META[platformId].name;
      const messages = {
        authenticate: `正在使用本机已保存的${name}账号登录；成功后会同步作业。`,
        login: `已请求打开${name}辅助登录窗口。完成验证后请检查登录状态，再读取作业。`,
        collect: `正在读取${name}作业。`,
      };
      toast(messages[action] || '操作已开始。', 'success', action === 'collect' ? 6500 : 10000);
      await refresh(true);
    } catch (error) { toast(error.message, 'error', 10000); }
    finally { model.busy.delete(platformId); renderPlatforms(); renderSync(); }
  }
  async function syncAll() {
    if (model.data?.sync?.running || model.hasSyncRequest || loginJobs().length || model.busy.size) return;
    if (!getPlatforms().some((platform) => platform.configured)) {
      toast('请先配置并登录至少一个课程平台。');
      $('#connections').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    model.hasSyncRequest = true;
    renderSync();
    try {
      await api('/api/sync', { method: 'POST', body: '{}' });
      toast('同步已开始。登录过期的平台可在平台卡片中重新登录。');
      await refresh(true);
    } catch (error) { toast(error.message, 'error'); }
    finally { model.hasSyncRequest = false; renderSync(); }
  }
  // A checkbox click is deliberately a read-only cloud confirmation request.
  // It never PATCHes the local `completed` flag. The collector is the only
  // source allowed to move a row into 已完成.
  async function confirmAssignmentOnCloud(input) {
    const id = input.dataset.assignment;
    if (model.pendingAssignments.has(id)) return;
    const assignment = assignments().find((item) => String(item.id) === id);
    if (!assignment) return;
    if (isPlatformComplete(assignment)) { renderAssignments(); return; }
    input.checked = false;
    model.pendingAssignments.add(id);
    input.disabled = true;
    try {
      // /collect performs a platform read only. The response is intentionally
      // not used as proof because it is asynchronous; the following state
      // refresh must contain the platform's verified submitted/completed
      // status before this row can be archived.
      await api(`/api/platforms/${encodeURIComponent(assignment.platform)}/collect`, { method: 'POST', body: '{}' });
      toast('正在向原平台核对状态。平台确认提交或完成后，任务才会移入“已完成”。', 'success', 7000);
      await refresh(true);
    } catch (error) {
      input.checked = false;
      toast(error.message, 'error');
    } finally {
      model.pendingAssignments.delete(id);
      render();
    }
  }

  $$('.primary-nav [data-view]').forEach((button) => button.addEventListener('click', () => changeView(button.dataset.view)));
  $$('[data-stat]').forEach((button) => button.addEventListener('click', () => changeView(button.dataset.stat)));
  $('#platform-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-platform-filter]');
    if (!button) return;
    model.platform = model.platform === button.dataset.platformFilter ? null : button.dataset.platformFilter;
    model.due = 'all';
    render();
    closeSidebar();
  });
  $$('.list-tab').forEach((button) => button.addEventListener('click', () => {
    model.tab = button.dataset.tab;
    if (model.tab === 'completed' && ['upcoming', 'overdue'].includes(model.due)) model.due = 'all';
    render();
  }));
  $('.list-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = $$('.list-tab');
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
  $('#search').addEventListener('input', (event) => { model.search = event.target.value; renderAssignments(); });
  $('#due-filter').addEventListener('change', (event) => {
    model.due = event.target.value;
    if (['upcoming', 'overdue'].includes(model.due) && model.tab === 'completed') model.tab = 'pending';
    render();
  });
  $('#sort-order').addEventListener('change', (event) => { model.sort = event.target.value; renderAssignments(); });
  $('#clear-filters').addEventListener('click', clearFilters);
  $('#assignments-list').addEventListener('change', (event) => {
    if (event.target.matches('input[data-assignment]')) void confirmAssignmentOnCloud(event.target);
  });
  $('#assignments-list').addEventListener('click', (event) => {
    const action = event.target.closest('[data-empty-action]')?.dataset.emptyAction;
    if (!action) return;
    if (action === 'clear') clearFilters();
    if (action === 'connect') $('#connections').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (action === 'pending') changeView('pending');
    if (action === 'all') { model.tab = 'all'; clearFilters(); }
    if (action === 'sync') void syncAll();
    if (action === 'retry') void refresh(true);
  });
  $('#platform-cards').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) void platformAction(button.dataset.platform, button.dataset.action);
  });
  $('#sync-all').addEventListener('click', () => void syncAll());
  $('#retry-state').addEventListener('click', () => void refresh(true));
  $('#open-settings').addEventListener('click', openSettings);
  $('#open-email-settings').addEventListener('click', openEmailSettings);
  $('#mobile-menu').addEventListener('click', () => {
    $('#sidebar').inert = false;
    $('#sidebar').classList.add('open');
    $('#sidebar-backdrop').hidden = false;
    $('#mobile-menu').setAttribute('aria-expanded', 'true');
  });
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSidebar(); });
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
  $$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  }));
  $('#credentials-dialog').addEventListener('close', () => $('#credentials-form').reset());
  $('#email-dialog').addEventListener('close', () => { $('#email-form').reset(); $('#email-password').value = ''; });
  $('#add-email-rule').addEventListener('click', () => {
    if ($$('#email-rules .email-rule').length >= 12) { $('#email-error').textContent = '最多添加 12 条规则。'; $('#email-error').hidden = false; return; }
    $('#email-rules .email-rules-empty')?.remove();
    $('#email-rules').insertAdjacentHTML('beforeend', emailRuleMarkup({ id: crypto.randomUUID(), kind: 'before', minutes: 1440, platform: 'all' }));
    $('#email-error').hidden = true;
  });
  $('#email-rules').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-email-rule]');
    if (!button) return;
    button.closest('.email-rule').remove();
    if (!$('#email-rules .email-rule')) renderEmailRules([]);
  });
  $('#email-security').addEventListener('change', () => {
    if (['465', '587'].includes($('#email-port').value)) $('#email-port').value = $('#email-security').value === 'ssl' ? 465 : 587;
  });
  $('#email-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    $('#email-error').hidden = true;
    let body;
    try {
      body = { enabled: $('#email-enabled').checked, host: $('#email-host').value.trim(), port: Number($('#email-port').value),
        secure: $('#email-security').value === 'ssl', username: $('#email-username').value.trim(),
        from: $('#email-from').value.trim(), to: $('#email-to').value.trim(),
        freshnessMinutes: Number($('#email-freshness').value), rules: collectEmailRules() };
      if ($('#email-password').value) body.password = $('#email-password').value;
      $('#save-email').disabled = true;
      await api('/api/email-settings', { method: 'PUT', body: JSON.stringify(body) });
      await refresh(true);
      $('#email-password').placeholder = '留空沿用已保存密码';
      $('#test-email').disabled = !Boolean(body.password || model.data?.emailSettings?.passwordConfigured);
      $('#email-delivery-status').textContent = '设置已保存。可以发送测试邮件。';
      toast('邮件提醒设置已保存。');
    } catch (error) { $('#email-error').textContent = error.message; $('#email-error').hidden = false; }
    finally { if (body) body.password = ''; $('#email-password').value = ''; $('#save-email').disabled = false; }
  });
  $('#test-email').addEventListener('click', async () => {
    $('#test-email').disabled = true;
    $('#email-error').hidden = true;
    try {
      await api('/api/email-test', { method: 'POST', body: '{}', timeoutMs: 60000 });
      $('#email-delivery-status').textContent = '测试邮件已提交给 SMTP 服务器，请检查收件箱。';
      toast('测试邮件已发送。');
      await refresh(true);
    } catch (error) { $('#email-error').textContent = error.message; $('#email-error').hidden = false; }
    finally { $('#test-email').disabled = false; }
  });
  $('#credentials-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const platformId = $('#credential-platform').value;
    const body = { username: $('#credential-username').value.trim(), password: $('#credential-password').value };
    if (platformId === 'xiji') {
      body.vpnUsername = $('#credential-vpn-username').value.trim();
      body.vpnPassword = $('#credential-vpn-password').value;
    }
    $('#save-credentials').disabled = true;
    $('#save-credentials').textContent = '正在保存…';
    $('#credentials-error').hidden = true;
    try {
      await api(`/api/platforms/${encodeURIComponent(platformId)}/credentials`, { method: 'POST', body: JSON.stringify(body) });
      $('#credentials-dialog').close();
      toast(`${PLATFORM_META[platformId].name}账号已保存，正在自动登录；成功后读取作业。`, 'success', 10000);
      await refresh(true);
    } catch (error) {
      $('#credentials-error').textContent = error.message;
      $('#credentials-error').hidden = false;
    } finally {
      body.password = '';
      if ('vpnPassword' in body) body.vpnPassword = '';
      $('#credential-password').value = '';
      $('#credential-vpn-password').value = '';
      $('#save-credentials').disabled = false;
      $('#save-credentials').textContent = '保存并登录';
    }
  });
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const body = { autoSync: $('#auto-sync').checked, syncIntervalMinutes: Number($('#sync-interval').value) };
    $('#save-settings').disabled = true;
    $('#settings-error').hidden = true;
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      $('#settings-dialog').close();
      toast('同步设置已保存。');
      await refresh(true);
    } catch (error) {
      $('#settings-error').textContent = error.message;
      $('#settings-error').hidden = false;
    } finally { $('#save-settings').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(true); });
  $('#today-date').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  $('#mobile-menu').setAttribute('aria-controls', 'sidebar');
  const mobileMedia = window.matchMedia('(max-width: 760px)');
  mobileMedia.addEventListener('change', () => { $('#sidebar').inert = mobileMedia.matches && !$('#sidebar').classList.contains('open'); });
  $('#sidebar').inert = mobileMedia.matches;
  void refresh();
})();
