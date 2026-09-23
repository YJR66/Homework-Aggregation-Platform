import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { saveBrowserState, restoreBrowserState } from './vault.mjs';
import { gotoReadOnly } from './navigation.mjs';
import { inspectLoginState, normalizeLoginSnapshot } from './auth-state.mjs';
import { solveTextCaptcha } from './captcha.mjs';
import { LocalOcrEngine } from './ocr.mjs';

// Passwords are only filled on the exact HTTPS origins below. In particular,
// a campus VPN's different proxied origins must not share a credential scope.
const HOSTS = Object.freeze({
  chaoxing: ['passport2.chaoxing.com', 'passport.chaoxing.com', 'i.chaoxing.com'],
  yuketang: ['www.yuketang.cn', 'yuketang.cn'],
  pta: ['pintia.cn', 'www.pintia.cn', 'passport.pintia.cn'],
});
const VPN_HOST = 'vpn.neuq.edu.cn';
const VPN_CAS_PREFIX = '/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/';
const XIJI_PREFIX = '/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const PLATFORM_IDS = new Set([...Object.keys(HOSTS), 'xiji']);

/** Identify a narrowly trusted authentication stage; never trust suffix matches. */
export function authenticationStage(platformId, value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  if (platformId === 'xiji') {
    if (url.hostname !== VPN_HOST) return null;
    if (url.pathname.startsWith(VPN_CAS_PREFIX)) return 'vpn';
    if (url.pathname.startsWith(XIJI_PREFIX)) return 'platform';
    if (url.pathname === '/login') return 'gateway';
    return null;
  }
  return HOSTS[platformId]?.includes(url.hostname) ? 'platform' : null;
}

export function trustedAuthUrl(platformId, value) {
  return authenticationStage(platformId, value) !== null;
}

/** Only a confirmed blank Xiji main document may recover to this known entry. */
export function xijiBlankMainEntry(platform, currentValue, inspection) {
  if (platform?.id !== 'xiji' || inspection?.authenticated !== null || inspection.blankProtectedPage !== true) return null;
  if (authenticationStage('xiji', currentValue) !== 'platform' || authenticationStage('xiji', platform.entryUrl) !== 'platform') return null;
  const current = new URL(currentValue);
  const entry = new URL(platform.entryUrl);
  if (current.pathname !== `${XIJI_PREFIX}main.jsp` || current.search || current.hash
    || entry.pathname !== `${XIJI_PREFIX}indexcs/simple.jsp` || entry.hash
    || [...entry.searchParams].some(([key, value]) => key !== 'loginErr' || value !== '0')) return null;
  return entry.href;
}

/** WebVPN rewrites the school CAS form while retaining its original action getter. */
export function trustedAuthFormAction(platformId, frameValue, actionValue) {
  const stage = authenticationStage(platformId, frameValue);
  if (!stage || stage === 'gateway') return false;
  if (!actionValue) return true;
  let frameUrl, target;
  try { frameUrl = new URL(frameValue); target = new URL(actionValue, frameValue); } catch { return false; }
  if (target.username || target.password) return false;
  if (target.origin === frameUrl.origin && authenticationStage(platformId, target.href) === stage) return true;
  if (platformId === 'xiji' && stage === 'platform' && target.pathname === '/login/loginproc.jsp'
    && [`https://${VPN_HOST}`, 'https://ccelab.neuq.edu.cn'].includes(target.origin)) return true;
  if (platformId !== 'xiji' || stage !== 'vpn' || target.pathname !== '/authserver/login') return false;
  if (![`https://${VPN_HOST}`, 'http://ids.neuq.edu.cn'].includes(target.origin)) return false;
  const service = target.searchParams.get('service');
  if (service) {
    let serviceUrl;
    try { serviceUrl = new URL(service); } catch { return false; }
    if (serviceUrl.origin !== `https://${VPN_HOST}` || serviceUrl.pathname !== '/login'
      || serviceUrl.username || serviceUrl.password || serviceUrl.searchParams.get('cas_login') !== 'true') return false;
  }
  return true;
}

export function credentialsForStage(credentials, stage) {
  if (stage === 'vpn') return { username: credentials?.vpnUsername || '', password: credentials?.vpnPassword || '' };
  if (stage === 'platform') return { username: credentials?.username || '', password: credentials?.password || '' };
  return { username: '', password: '' };
}

/** A landing URL alone is not proof that CAS has completed. */
export function authenticatedVpnPortal({ url: value, readyState, hasLoginForm, hasLoginControl, hasChallenge, hasLogoutControl } = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === `https://${VPN_HOST}`
    && !url.username && !url.password
    && ['/', '/index'].includes(url.pathname)
    && !/(?:[?&#](?:ticket|service|cas_login|code)=|(?:^|[/#])(?:login|auth|callback)(?:$|[/?#]))/i.test(url.search + url.hash)
    && ['interactive', 'complete'].includes(readyState)
    && hasLoginForm === false && hasLoginControl === false && hasChallenge === false
    && hasLogoutControl === true;
}

function findBrowserExecutable() {
  const env = process.env;
  const candidates = [
    env.HOMEWORK_BROWSER_PATH,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform === 'linux' && '/usr/bin/google-chrome',
    process.platform === 'linux' && '/usr/bin/chromium',
    chromium.executablePath(),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

const USER_SELECTORS = [
  '#phone', '#username', '#userName', '#uname', '#loginName', '#userId',
  'input[name="username"]', 'input[name="userName"]', 'input[name="uname"]',
  'input[name="phone"]', 'input[name="mobile"]', 'input[name="loginName"]',
  'input[autocomplete="username"]', 'input[type="email"]', 'input[type="tel"]',
  'input[placeholder*="账号"]', 'input[placeholder*="学号"]', 'input[placeholder*="手机号"]',
  'input[placeholder*="用户名"]', 'input[placeholder*="邮箱"]',
];
const PASSWORD_SELECTORS = ['#pwd', '#password', 'input[name="pwd"]', 'input[type="password"]'];
const CAPTCHA_SELECTORS = [
  'input[placeholder*="验证码"]', 'input[name*="captcha" i]', 'input[id*="captcha" i]',
  'input[name="verifyCode"]', 'input[name="captchaResponse"]',
  '[class*="geetest"]', '[id*="captcha" i]', 'iframe[src*="captcha" i]',
  'iframe[src*="verify" i]', '[class*="slider-verification"]',
];

async function firstVisible(frame, selectors) {
  for (const selector of selectors) {
    const locator = frame.locator(selector);
    for (let i = 0; i < Math.min(await locator.count(), 10); i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

// Unlike checking frame.url() immediately before locator.fill(), this check and
// write happen synchronously in the same document. A redirect cannot move the
// password into a newly loaded, untrusted document between the two operations.
async function fillTrustedInput(locator, value, frameUrl, formActions) {
  const expected = new URL(frameUrl);
  return locator.evaluate((element, { value, origin, pathname, formActions }) => {
    const view = element.ownerDocument.defaultView;
    if (view.location.origin !== origin || view.location.pathname !== pathname) return false;
    // Both action representations were validated, including the narrow WebVPN
    // CAS exception. They must remain unchanged inside this atomic DOM write.
    if ((element.form?.getAttribute('action') || '') !== formActions.raw
      || (element.form?.action || '') !== formActions.resolved) return false;
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(new view.Event('input', { bubbles: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    // Rain Classroom validates its mobile field on keyup, not input alone.
    element.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
    element.blur();
    return true;
  }, { value, origin: expected.origin, pathname: expected.pathname, formActions });
}

/**
 * One isolated persistent browser profile per platform. Authentication reuses
 * valid sessions before loading credentials, with bounded local captcha OCR.
 * No tracing, screenshots, password logging, or exported storage state.
 */
export class BrowserManager {
  constructor({ dataDir, getCredentials, onStatus = () => {}, ocr, inspect = inspectLoginState, captchaSolver = solveTextCaptcha }) {
    if (!dataDir) throw new Error('BrowserManager 需要 dataDir。');
    this.dataDir = path.resolve(dataDir);
    this.getCredentials = getCredentials || (async () => ({}));
    this.onStatus = onStatus;
    this.sessions = new Map();
    this.pending = new Map();
    this.authJobs = new Map();
    this.blockedAuth = new Map();
    this.ocr = ocr || new LocalOcrEngine({ dataDir: this.dataDir });
    this.inspect = inspect;
    this.captchaSolver = captchaSolver;
    this.executablePath = findBrowserExecutable();
    this.browserAvailable = Boolean(this.executablePath);
    this.closed = false;
  }

  isOpen(id) {
    const session = this.sessions.get(id);
    return Boolean(session?.interactive && !session.closed);
  }

  resetLoginAttempts(id) {
    this.blockedAuth.delete(id);
    const session = this.sessions.get(id);
    if (session) { session.attempts.clear(); session.filled.clear(); session.lastStatus = ''; session.halted = false; }
  }

  get ocrAvailable() { return this.ocr.isAvailable(); }

  #recordAuth(platform, result) {
    if (this.closed) return { authenticated: null, reason: '登录检查已取消，服务正在停止。' };
    const loginStatus = result.authenticated === true ? 'authenticated' : result.invalidCredentials ? 'invalid_credentials'
      : result.challengeType ? 'challenge' : result.authenticated === false ? 'expired' : 'unknown';
    this.onStatus(platform.id, { loginStatus, authMessage: result.reason, lastAuthCheckAt: new Date().toISOString() });
    return result;
  }

  async verifySession(platform, { navigate = true, waitMs = 8000, navigationTimeoutMs = 30000, deadline = Infinity } = {}) {
    const { page } = await this.getSession(platform);
    const session = this.sessions.get(platform.id);
    if (session) session.probing = true;
    try {
      if (navigate) await gotoReadOnly(page, platform.syncUrl || platform.entryUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }, { maxAttempts: 1 });
      const until = Math.min(Date.now() + waitMs, deadline);
      let result;
      let entryRecoveryAttempted = false;
      do {
        if (this.closed || page.isClosed()) break;
        result = await this.inspect(page, platform).catch(() => ({ authenticated: null, reason: '登录页面仍在加载。' }));
        if (this.closed || page.isClosed()) return this.#recordAuth(platform, { authenticated: null, reason: '登录检查已取消，页面已关闭。' });
        const recoveryEntry = navigate && !entryRecoveryAttempted && Date.now() < deadline
          ? xijiBlankMainEntry(platform, page.url(), result) : null;
        if (recoveryEntry) {
          entryRecoveryAttempted = true;
          await gotoReadOnly(page, recoveryEntry, {
            waitUntil: 'domcontentloaded', timeout: Math.min(navigationTimeoutMs, Math.max(1, deadline - Date.now())),
          }, { maxAttempts: 1 });
          if (this.closed || page.isClosed()) return this.#recordAuth(platform, { authenticated: null, reason: '登录检查已取消，页面已关闭。' });
          result = await this.inspect(page, platform).catch(() => ({ authenticated: null, reason: '登录入口仍在加载，未尝试账号密码登录。' }));
          if (this.closed || page.isClosed()) return this.#recordAuth(platform, { authenticated: null, reason: '登录检查已取消，页面已关闭。' });
        }
        if (result.authenticated !== null) return this.#recordAuth(platform, result);
        await delay(350);
      } while (Date.now() < until);
      return this.#recordAuth(platform, result || { authenticated: null, reason: '登录页面不可用，请重新验证。' });
    } catch {
      return this.#recordAuth(platform, { authenticated: null, reason: '平台连接失败，未尝试账号密码登录。' });
    } finally { if (session) session.probing = false; }
  }

  /** One transaction per platform; wrong passwords remain blocked until edited. */
  authenticate(platform, options = {}) {
    if (this.authJobs.has(platform.id)) return this.authJobs.get(platform.id);
    const job = this.#authenticate(platform, options).finally(() => this.authJobs.delete(platform.id));
    this.authJobs.set(platform.id, job);
    return job;
  }

  async #authenticate(platform, { interactive = false, navigate = true, timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + Math.max(1000, Math.min(120000, timeoutMs));
    await this.getSession(platform, { interactive });
    const session = this.sessions.get(platform.id);
    if (interactive) await session.page.bringToFront().catch(() => {});
    session.authenticating = true;
    session.authVerified = false;
    session.halted = false;
    session.captchaChallenges = new Set();
    session.captchaRounds = 0;
    session.refreshCaptcha = false;
    session.failure = null;
    session.dialogResult = null;
    session.deadline = deadline;
    session.attempts.clear(); session.filled.clear(); session.lastStatus = '';
    this.onStatus(platform.id, { loginStatus: 'authenticating', authMessage: '正在检查登录状态…', authOpen: session.interactive });
    let result = { authenticated: null, reason: '登录验证超时，请重新填写账号密码或点击「已保存账号登录」。' };
    try {
      if (Date.now() >= deadline) return this.#recordAuth(platform, result);
      result = await this.verifySession(platform, { navigate, deadline, waitMs: Math.min(8000, deadline - Date.now()), navigationTimeoutMs: Math.min(30000, Math.max(1, deadline - Date.now())) });
      while (!this.closed && !session.closed && Date.now() < deadline) {
        if (result.authenticated === true) {
          session.authVerified = true;
          this.blockedAuth.delete(platform.id);
          await saveBrowserState(this.dataDir, platform.id, session.context).catch(() => {});
          return this.#recordAuth(platform, result);
        }
        if (result.invalidCredentials) {
          this.blockedAuth.set(platform.id, result);
          return this.#recordAuth(platform, result);
        }
        if (this.blockedAuth.has(platform.id)) return this.#recordAuth(platform, this.blockedAuth.get(platform.id));
        // An unknown/network state is never permission to try the password.
        if (result.authenticated === null) return this.#recordAuth(platform, result);
        if (result.captchaRejected && session.attempts.has(result.stage || 'platform')) {
          if (session.captchaRounds < 2 && platform.id === 'xiji' && result.stage === 'platform') session.refreshCaptcha = true;
          else return this.#recordAuth(platform, { ...result, reason: '验证码未通过，请在登录窗口处理。' });
        }
        if (session.refreshCaptcha) {
          session.refreshCaptcha = false;
          if (platform.id !== 'xiji' || session.captchaRounds >= 2) break;
          // Only refresh the known read-only login entry, never a form POST.
          await gotoReadOnly(session.page, platform.entryUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }, { maxAttempts: 1 });
          session.attempts.delete('platform'); session.filled.delete('platform');
          session.dialogResult = null;
        }
        await this.#assistLogin(session);
        if (session.failure) return this.#recordAuth(platform, { authenticated: false, ...session.failure });
        if (session.refreshCaptcha) continue;
        await delay(600);
        result = session.dialogResult || await this.inspect(session.page, platform).catch(() => ({ authenticated: null, reason: '登录跳转仍在加载。' }));
        // Permit transient navigation after the single login submission.
        if (result.authenticated === null) {
          for (let n = 0; n < 12 && Date.now() < deadline && result.authenticated === null && !this.closed && !session.closed; n++) {
            await delay(500);
            result = await this.inspect(session.page, platform).catch(() => result);
          }
        }
      }
      return this.#recordAuth(platform, { ...result, ...(this.closed || session.closed ? { authenticated: null } : {}), reason: '登录未完成，请在登录窗口继续。' });
    } catch {
      return this.#recordAuth(platform, { authenticated: null, reason: '登录过程连接中断，未重复提交密码。' });
    } finally { session.authenticating = false; session.halted = true; session.deadline = null; }
  }

  async openLogin(platform) {
    const { page } = await this.getSession(platform, { interactive: true });
    const session = this.sessions.get(platform.id);
    session.halted = false; session.failure = null; session.authVerified = false;
    await page.bringToFront().catch(() => {});
    this.#status(session, 'auth_required', '登录窗口已打开，正在尝试识别验证码。');
    await this.#assistLogin(session);
    return { ok: true, message: '登录窗口已打开。登录后请同步作业。' };
  }

  async getSession(platform, { interactive = false } = {}) {
    if (this.closed) throw new Error('浏览器管理器已关闭。');
    if (!PLATFORM_IDS.has(platform?.id)) throw new Error('不支持的作业平台。');
    if (!trustedAuthUrl(platform.id, platform.entryUrl)) throw new Error('平台入口不在受信任的 HTTPS 地址列表。');
    if (this.pending.has(platform.id)) {
      await this.pending.get(platform.id);
      return this.getSession(platform, { interactive });
    }
    let session = this.sessions.get(platform.id);
    if (session && !session.closed && (!interactive || session.interactive)) {
      const pages = session.context.pages().filter((item) => !item.isClosed());
      if (pages.length) {
        if (session.page.isClosed()) session.page = pages.at(-1);
        return { context: session.context, page: session.page };
      }
    }
    const pending = (async () => {
      if (session && !session.closed) {
        clearInterval(session.saveInterval);
        await session.saving;
        await saveBrowserState(this.dataDir, platform.id, session.context).catch(() => {});
        await session.context.close().catch(() => {});
      }
      session = await this.#createSession(platform, interactive);
      return { context: session.context, page: session.page };
    })();
    this.pending.set(platform.id, pending);
    try { return await pending; } finally { this.pending.delete(platform.id); }
  }

  async #createSession(platform, interactive) {
    if (!this.browserAvailable) throw new Error('未找到 Chrome / Edge。请安装浏览器，或设置 HOMEWORK_BROWSER_PATH。');
    const profileDir = path.join(this.dataDir, 'profiles', platform.id);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    let context;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: this.executablePath,
        headless: !interactive,
        viewport: interactive ? null : { width: 1440, height: 1000 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        acceptDownloads: false,
        args: ['--no-first-run', '--no-default-browser-check'],
      });
    } catch {
      this.onStatus(platform.id, { status: 'error', message: '浏览器启动失败。请关闭该平台已有的独立窗口后重试。', authOpen: false });
      throw new Error('浏览器启动失败，可能是本地登录窗口或 profile 正被另一进程使用。');
    }
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(45000);
    await restoreBrowserState(this.dataDir, platform.id, context).catch(() => {});
    const page = context.pages().at(-1) || await context.newPage();
    const session = {
      platform, context, page, interactive, closed: false,
      attempts: new Set(), filled: new Set(), assisting: false, interval: null,
      lastStatus: '',
    };
    session.saveInterval = setInterval(() => {
      if (!session.closed && !session.saving) {
        session.saving = saveBrowserState(this.dataDir, platform.id, context).catch(() => {}).finally(() => { session.saving = null; });
      }
    }, 20000);
    session.saveInterval.unref?.();
    this.sessions.set(platform.id, session);
    context.on('close', () => {
      session.closed = true;
      clearInterval(session.interval);
      clearInterval(session.saveInterval);
      if (this.sessions.get(platform.id) === session) this.sessions.delete(platform.id);
      if (session.interactive) this.onStatus(platform.id, { authOpen: false, message: '登录窗口已关闭。' });
    });
    const attachDialogs = (target) => target.on('dialog', async dialog => {
      if (session.authenticating && authenticationStage(platform.id, target.url())) {
        const parsed = normalizeLoginSnapshot({ url: target.url(), readyState: 'complete', hasPassword: true, errorText: dialog.message() }, platform);
        if (parsed.invalidCredentials || parsed.captchaRejected) session.dialogResult = parsed;
      }
      await dialog.dismiss().catch(() => {});
    });
    for (const target of context.pages()) attachDialogs(target);
    context.on('page', (newPage) => { session.page = newPage; attachDialogs(newPage); });
    try {
      // Never navigate away from a preserved login/assignment page.
      if (!page.url() || page.url() === 'about:blank') await gotoReadOnly(page, platform.entryUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      // The visible window remains usable for a retry by the user. No raw
      // navigation exception is surfaced because it can contain sensitive URLs.
      this.#status(session, 'error', '平台页面加载超时或连接失败，请检查网络后在登录窗口重试。');
    }
    if (interactive) {
      session.interval = setInterval(() => { if (!session.authenticating && !session.probing && !session.halted && !session.authVerified) void this.#assistLogin(session); }, 4000);
      session.interval.unref?.();
    }
    return session;
  }

  #status(session, status, message) {
    if (!session || session.closed) return;
    const signature = `${status}:${message}`;
    if (session.lastStatus === signature) return;
    session.lastStatus = signature;
    this.onStatus(session.platform.id, { status, message, authOpen: session.interactive });
  }

  async #resumeXijiFromPortal(session, page) {
    if (session.platform.id !== 'xiji' || page !== session.page
      || (!session.authenticating && !session.attempts.has('vpn')) || session.attempts.has('portal-resume')) return;
    const value = page.url();
    // Cheap URL guard prevents inspecting or changing CAS/challenge pages.
    let url;
    try { url = new URL(value); } catch { return; }
    if (url.origin !== `https://${VPN_HOST}` || !['/', '/index'].includes(url.pathname)) return;
    const snapshot = await page.evaluate(() => {
      const visible = (element) => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
      const controls = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],span,li')].filter(visible);
      const label = (element) => (element.getAttribute('aria-label') || element.innerText || element.value || '').replace(/\s+/g, '').trim();
      const hasLogoutControl = /欢迎您/.test(document.body?.innerText || '') && /校内应用/.test(document.body?.innerText || '') || controls.some((element) => {
        if (/^(?:退出|退出登录|退出系统|注销|注销登录|登出|logout|signout)$/i.test(label(element))) return true;
        if (element.tagName !== 'A') return false;
        try {
          const target = new URL(element.getAttribute('href'), location.href);
          return target.origin === location.origin && /^\/(?:logout|signout)\/?$/i.test(target.pathname);
        } catch { return false; }
      });
      const hasLoginControl = controls.some((element) => /^(?:登录|立即登录|扫码登录|CAS统一身份认证登录|统一身份认证登录|login|signin)$/i.test(label(element)));
      const hasLoginForm = [...document.querySelectorAll('input[type="password"]')].some(visible);
      const hasChallenge = [...document.querySelectorAll('input[name*="captcha" i],input[id*="captcha" i],[class*="geetest"],[id*="captcha" i],iframe[src*="captcha" i],iframe[src*="verify" i],input[placeholder*="验证码"]')].some(visible)
        || /正在(?:认证|登录|验证)|认证处理中|请完成.{0,12}验证|拖动.{0,12}(?:滑块|拼图)/.test(document.body?.innerText || '');
      return { url: location.href, readyState: document.readyState, hasLoginForm, hasLoginControl, hasChallenge, hasLogoutControl };
    });
    if (!authenticatedVpnPortal(snapshot) || page.url() !== snapshot.url) return;
    // A visible challenge in an embedded CAS frame also blocks navigation.
    for (const frame of page.frames()) {
      if (await firstVisible(frame, [...PASSWORD_SELECTORS, ...CAPTCHA_SELECTORS])) return;
    }
    if (page.url() !== snapshot.url) return;
    session.attempts.add('portal-resume');
    this.#status(session, 'auth_required', '学校 VPN 已登录，正在打开希冀。');
    try {
      await page.goto(session.platform.entryUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      this.#status(session, 'awaiting_user', '希冀入口加载超时，请在登录窗口重试。');
    }
  }

  async #assistLogin(session) {
    if ((!session?.interactive && !session?.authenticating) || session.closed || session.assisting) return;
    session.assisting = true;
    try {
      const pages = session.context.pages().filter((page) => !page.isClosed());
      if (session.page.isClosed() && pages.length) session.page = pages.at(-1);
      for (const page of session.context.pages()) {
        if (page.isClosed() || session.deadline && Date.now() >= session.deadline) continue;
        await this.#resumeXijiFromPortal(session, page);
        for (const frame of page.frames()) {
          const stage = authenticationStage(session.platform.id, frame.url());
          if (!stage) continue;
          if (stage === 'gateway') {
            if (session.attempts.has(stage)) continue;
            const casLink = frame.getByRole('link', { name: 'CAS统一身份认证登录', exact: true });
            if (!(await casLink.isVisible().catch(() => false))) continue;
            const href = await casLink.getAttribute('href');
            const target = href ? new URL(href, frame.url()) : null;
            if (target?.origin !== `https://${VPN_HOST}` || target.pathname !== '/login' || target.searchParams.get('cas_login') !== 'true') continue;
            session.attempts.add(stage);
            await casLink.click({ timeout: 8000 });
            this.#status(session, 'auth_required', '正在登录学校 VPN。');
            continue;
          }
          if (session.attempts.has(stage)) continue;
          if (session.platform.id === 'yuketang' && !session.attempts.has('password-mode')) {
            const switchMode = frame.getByRole('img', { name: '账号密码登录', exact: true });
            if (await switchMode.isVisible().catch(() => false)) {
              session.attempts.add('password-mode');
              await switchMode.click({ timeout: 8000 });
            }
          }
          const password = await firstVisible(frame, PASSWORD_SELECTORS);
          const username = await firstVisible(frame, USER_SELECTORS);
          if (!password || !username) {
            if (session.platform.id === 'pta' && !session.attempts.has('login-modal')) {
              const openModal = frame.getByRole('button', { name: /^登录$/ });
              if (await openModal.count() === 1 && await openModal.isVisible()) {
                session.attempts.add('login-modal');
                await openModal.click({ timeout: 8000 });
                this.#status(session, 'auth_required', '正在填写 PTA 登录表单。');
              }
            }
            continue;
          }
          // A trusted frame must not send credentials to an untrusted form target.
          const formActions = await password.evaluate((element) => ({ raw: element.form?.getAttribute('action') || '', resolved: element.form?.action || '' }));
          if (!trustedAuthFormAction(session.platform.id, frame.url(), formActions.raw)
            || !trustedAuthFormAction(session.platform.id, frame.url(), formActions.resolved)) {
            this.#status(session, 'awaiting_user', '登录表单地址无法确认，请在登录窗口操作。');
            continue;
          }
          const credentials = credentialsForStage(await this.getCredentials(session.platform.id), stage);
          if (!credentials.username || !credentials.password) {
            session.failure = { stage, reason: stage === 'vpn' ? '请在设置中补充学校统一身份认证账号密码。' : '请在设置中补充平台账号密码。' };
            this.#status(session, 'awaiting_user', stage === 'vpn' ? '请填写学校 VPN 账号密码，或在登录窗口操作。' : '请填写平台账号密码，或在登录窗口操作。');
            continue;
          }
          // Re-check after async credential retrieval in case navigation occurred.
          if (authenticationStage(session.platform.id, frame.url()) !== stage) continue;
          if (!session.filled.has(stage)) {
            const frameUrl = frame.url();
            if (!(await fillTrustedInput(username, credentials.username, frameUrl, formActions))) continue;
            if (!(await fillTrustedInput(password, credentials.password, frameUrl, formActions))) continue;
            session.filled.add(stage);
          }
          const captcha = await firstVisible(frame, CAPTCHA_SELECTORS);
          if (captcha) {
            const solved = await this.captchaSolver({ frame, platformId: session.platform.id, stage, ocr: this.ocr });
            session.captchaChallenges ||= new Set();
            session.captchaRounds ||= 0;
            if (solved.challengeKey) session.captchaRounds++;
            if (!solved.filled || !solved.challengeKey || session.captchaChallenges.has(solved.challengeKey) || session.captchaRounds > 2) {
              if (session.authenticating && solved.challengeKey && session.captchaRounds < 2 && session.platform.id === 'xiji' && stage === 'platform') {
                session.refreshCaptcha = true;
                return;
              }
              session.failure = { challengeType: solved.type, stage, reason: solved.reason || '验证码需要辅助登录。' };
              session.halted = true;
              this.#status(session, 'awaiting_user', session.failure.reason);
              return;
            }
            session.captchaChallenges.add(solved.challengeKey);
          }
          const agreements = frame.getByRole('checkbox');
          let uncheckedAgreement = false;
          for (let i = 0; i < await agreements.count(); i++) {
            const checkbox = agreements.nth(i);
            if (!(await checkbox.isVisible().catch(() => false)) || await checkbox.isChecked().catch(() => false)) continue;
            const label = await checkbox.evaluate((element) => [...(element.labels || [])].map((item) => item.textContent || '').join(' ') || element.parentElement?.textContent || '');
            if (/同意|协议|条款|隐私|agree|terms|privacy/i.test(label)) uncheckedAgreement = true;
          }
          if (uncheckedAgreement) {
            session.attempts.add(stage);
            session.failure = { stage, reason: '登录页面需要确认用户协议，请打开辅助登录阅读并处理。' };
            this.#status(session, 'awaiting_user', '请确认页面协议并点击登录。');
            continue;
          }
          const button = frame.getByRole('button', { name: /^(?:登\s*录|立即登录|Login|Log in|Sign in)$/i });
          const link = frame.getByRole('link', { name: /^登\s*录$/ });
          const submit = await firstVisible(frame, ['input[type="submit"][value="登录"]']);
          const rainSubmit = session.platform.id === 'yuketang'
            ? frame.locator('div.submit-btn.login-btn').filter({ hasText: /^登\s*录$/ }) : null;
          const visibleRainSubmit = rainSubmit && await rainSubmit.count() === 1 && await rainSubmit.isVisible() ? rainSubmit : null;
          const login = (await button.count() === 1 && await button.isVisible()) ? button
            : (await link.count() === 1 && await link.isVisible()) ? link : submit || visibleRainSubmit;
          // Mark this stage before clicking, including ambiguous/unknown forms:
          // polling must never repeatedly attempt the same password.
          session.attempts.add(stage);
          const explicitlyDisabled = login ? await login.evaluate((element) => element.classList.contains('disabled') || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')) : false;
          if (!login || !(await login.isEnabled()) || explicitlyDisabled) {
            session.failure = { stage, reason: '登录按钮尚未启用或无法识别，请打开辅助登录检查必填项及协议。' };
            this.#status(session, 'awaiting_user', explicitlyDisabled
              ? '登录按钮未启用，请检查必填项；协议需自行确认。'
              : '请在登录窗口点击登录。');
            continue;
          }
          if (session.deadline && Date.now() >= session.deadline) return;
          await login.click({ timeout: Math.min(8000, session.deadline ? Math.max(1, session.deadline - Date.now()) : 8000) });
          this.#status(session, 'auth_required', stage === 'vpn'
            ? '学校 VPN 登录已提交，正在打开希冀。'
            : '登录已提交，正在检查结果。');
        }
      }
    } catch {
      // Navigation during inspection is normal; never expose error text or values.
    } finally {
      session.assisting = false;
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      clearInterval(session.saveInterval);
      await session.saving;
      await saveBrowserState(this.dataDir, session.platform.id, session.context).catch(() => {});
      await session.context.close();
    }));
    this.sessions.clear();
    await Promise.allSettled([...this.authJobs.values()]);
    await this.ocr.close();
  }
}
