import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../server/browser.mjs';

const XIJI = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/indexcs/simple.jsp';
const XIJI_MAIN = XIJI.replace('indexcs/simple.jsp', 'main.jsp');
const signedIn = { authenticated: true, stage: 'platform', challengeType: null, reason: '个人课程页已核验' };
const signedOut = { authenticated: false, stage: 'platform', challengeType: null, reason: '登录表单可见' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const emptyLocator = () => ({ count: async () => 0, isVisible: async () => false, filter() { return this; } });

function fixture({ id = 'yuketang', inspect, captcha = false, solver, navigationError = false } = {}) {
  const platform = { id, entryUrl: id === 'xiji' ? XIJI : 'https://www.yuketang.cn/web', syncUrl: id === 'xiji' ? XIJI_MAIN : 'https://www.yuketang.cn/v2/web/index' };
  const state = { credentialReads: 0, clicks: 0, captchaCalls: 0, visits: [], closed: false, ocrCloses: 0, statuses: [], password: 'fixture-password', wrongPassword: false };
  let currentUrl = platform.entryUrl;
  class Input {
    constructor() { this.ownerDocument = { defaultView: view }; this.events = []; }
    set value(value) { this.stored = value; }
    get value() { return this.stored; }
    focus() { this.events.push('focus'); }
    blur() { this.events.push('blur'); }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  class Event { constructor(type) { this.type = type; } }
  const view = { get location() { return new URL(currentUrl); }, HTMLInputElement: Input, Event, KeyboardEvent: Event };
  function input() {
    const element = new Input();
    const locator = { element, count: async () => 1, nth: () => locator, isVisible: async () => !state.closed,
      evaluate: async (callback, args) => { if (state.closed) throw new Error('page closed'); return callback(element, args); } };
    return locator;
  }
  const username = input(); const password = input(); const captchaInput = input();
  const loginElement = { classList: { contains: () => false }, getAttribute: () => null, hasAttribute: () => false };
  const login = {
    count: async () => 1, isVisible: async () => !state.closed, isEnabled: async () => true,
    evaluate: async callback => callback(loginElement), click: async () => { state.clicks++; },
  };
  const frame = {
    url: () => currentUrl,
    locator: selector => selector === '#phone' ? username : selector === '#pwd' ? password
      : captcha && selector === 'input[placeholder*="验证码"]' ? captchaInput : emptyLocator(),
    getByRole: role => role === 'button' ? login : emptyLocator(),
  };
  const page = {
    url: () => currentUrl, isClosed: () => state.closed, frames: () => [frame], bringToFront: async () => {},
    goto: async url => { state.visits.push(url); if (navigationError) throw new Error('offline fixture connection unavailable'); currentUrl = url; },
  };
  let session;
  const context = {
    pages: () => [page], storageState: async () => { throw new Error('no disk writes in unit fixture'); },
    close: async () => { state.closed = true; session.closed = true; },
  };
  const ocr = { isAvailable: () => true, close: async () => { state.ocrCloses++; } };
  const manager = new BrowserManager({ dataDir: './unused-test-auth-profile', ocr,
    getCredentials: async () => { state.credentialReads++; return { username: 'fixture-user', password: state.password }; },
    onStatus: (_id, patch) => state.statuses.push(patch),
    inspect: async (...args) => inspect ? inspect(state, ...args) : state.clicks ? signedIn : signedOut,
    captchaSolver: async args => { state.captchaCalls++; return solver ? solver(state, args) : { filled: false, type: 'slider', reason: '交互验证码需要辅助登录' }; },
  });
  session = { platform, context, page, interactive: false, closed: false, attempts: new Set(), filled: new Set(), assisting: false, lastStatus: '' };
  manager.sessions.set(id, session);
  return { manager, platform, session, state, username, password };
}

test('valid session is verified without loading credentials, OCR, or a login submission', async () => {
  const f = fixture({ inspect: () => signedIn });
  try {
    const result = await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 2000 });
    assert.equal(result.authenticated, true);
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.state.clicks, 0);
    assert.equal(f.state.captchaCalls, 0);
    assert.equal(f.session.authVerified, true);
    assert.equal(f.session.authenticating, false);
    assert.equal(f.manager.authJobs.size, 0);
  } finally { await f.manager.close(); }
});

test('verification connection failure stays unknown and never attempts passwords', async () => {
  const f = fixture({ navigationError: true });
  try {
    const result = await f.manager.authenticate(f.platform, { timeoutMs: 2000 });
    assert.equal(result.authenticated, null);
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.state.clicks, 0);
    assert.equal(f.state.captchaCalls, 0);
    assert.match(result.reason, /未尝试账号密码登录/);
  } finally { await f.manager.close(); }
});

test('unknown protected-page shell never implies permission for password login', async () => {
  const f = fixture();
  f.manager.verifySession = async () => ({ authenticated: null, reason: '课程页面尚在加载' });
  try {
    assert.equal((await f.manager.authenticate(f.platform, { navigate: false })).authenticated, null);
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.state.clicks, 0);
  } finally { await f.manager.close(); }
});

test('Xiji blank main recovers its known entry read-only before classifying login state', async () => {
  const f = fixture({ id: 'xiji', inspect: (_state, page) => page.url() === XIJI_MAIN
    ? { authenticated: null, blankProtectedPage: true, reason: '空白 main.jsp' }
    : { ...signedOut, challengeType: 'text' } });
  try {
    const result = await f.manager.verifySession(f.platform, { waitMs: 0 });
    assert.equal(result.authenticated, false);
    assert.equal(result.challengeType, 'text');
    assert.deepEqual(f.state.visits, [XIJI_MAIN, XIJI]);
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.state.clicks, 0);
    assert.equal(f.state.captchaCalls, 0);
  } finally { await f.manager.close(); }
});

test('Xiji authentication can proceed only after the recovered entry proves a visible login form', async () => {
  const f = fixture({ id: 'xiji', inspect: (state, page) => state.clicks ? signedIn
    : page.url() === XIJI_MAIN ? { authenticated: null, blankProtectedPage: true, reason: '空白 main.jsp' } : signedOut });
  try {
    const result = await f.manager.authenticate(f.platform, { timeoutMs: 3000 });
    assert.equal(result.authenticated, true);
    assert.deepEqual(f.state.visits, [XIJI_MAIN, XIJI]);
    assert.equal(f.state.credentialReads, 1);
    assert.equal(f.state.clicks, 1);
  } finally { await f.manager.close(); }
});

test('a still-unknown Xiji recovery entry never causes credentials to be read or submitted', async () => {
  const f = fixture({ id: 'xiji', inspect: () => ({ authenticated: null, blankProtectedPage: true, reason: '仍为空白' }) });
  try {
    const result = await f.manager.authenticate(f.platform, { timeoutMs: 1000 });
    assert.equal(result.authenticated, null);
    assert.deepEqual(f.state.visits, [XIJI_MAIN, XIJI], 'known entry is recovered at most once');
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.state.clicks, 0);
    assert.equal(f.state.captchaCalls, 0);
  } finally { await f.manager.close(); }
});

test('one successful password submission is followed by a positive session verification', async () => {
  const f = fixture();
  try {
    assert.equal((await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 3000 })).authenticated, true);
    assert.equal(f.state.clicks, 1);
    assert.equal(f.state.credentialReads, 1);
    assert.equal(f.password.element.value, 'fixture-password');
    assert.equal(f.state.statuses.at(-1).loginStatus, 'authenticated');
    assert.equal(JSON.stringify(f.state.statuses).includes('fixture-password'), false);
  } finally { await f.manager.close(); }
});

test('bad credentials submit once, stay blocked, and reset after a password edit', async () => {
  const f = fixture({ inspect: state => state.wrongPassword && state.clicks ? { ...signedOut, invalidCredentials: true, reason: '账号或密码不正确' } : state.clicks >= 2 ? signedIn : signedOut });
  f.state.wrongPassword = true;
  try {
    const first = await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 3000 });
    assert.equal(first.invalidCredentials, true);
    assert.equal(f.state.clicks, 1);
    assert.equal(f.manager.blockedAuth.has(f.platform.id), true);
    await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 3000 });
    assert.equal(f.state.clicks, 1);
    assert.equal(f.state.credentialReads, 1);
    f.state.password = 'fixture-updated-password';
    f.state.wrongPassword = false;
    f.manager.resetLoginAttempts(f.platform.id);
    assert.equal((await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 3000 })).authenticated, true);
    assert.equal(f.state.clicks, 2);
    assert.equal(f.password.element.value, 'fixture-updated-password');
    assert.equal(f.manager.blockedAuth.has(f.platform.id), false);
  } finally { await f.manager.close(); }
});

test('same-platform concurrent authentication calls share one verification transaction', async () => {
  const gate = deferred(); let inspections = 0;
  const f = fixture({ inspect: async () => { inspections++; return gate.promise; } });
  try {
    const first = f.manager.authenticate(f.platform, { navigate: false });
    const second = f.manager.authenticate(f.platform, { navigate: false });
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspections, 1);
    gate.resolve(signedIn);
    assert.equal((await first).authenticated, true);
    assert.equal((await second).authenticated, true);
    assert.equal(f.state.credentialReads, 0);
    assert.equal(f.manager.authJobs.size, 0);
  } finally { gate.resolve(signedIn); await f.manager.close(); }
});

test('unsupported challenges stop without submitting a password form', async () => {
  const f = fixture({ captcha: true });
  try {
    const result = await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 3000 });
    assert.equal(result.authenticated, false);
    assert.equal(result.challengeType, 'slider');
    assert.equal(f.state.captchaCalls, 1);
    assert.equal(f.state.clicks, 0);
    assert.equal(f.session.halted, true);
  } finally { await f.manager.close(); }
});

test('Xiji captcha rejections allow only two distinct local OCR/login attempts', async () => {
  const f = fixture({ id: 'xiji', captcha: true,
    inspect: state => ({ ...signedOut, challengeType: 'text', captchaRejected: state.clicks > 0 }),
    solver: state => ({ filled: true, challengeKey: `captcha-${state.captchaCalls}`, type: 'text' }),
  });
  try {
    const result = await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 6000 });
    assert.equal(result.authenticated, false);
    assert.equal(result.captchaRejected, true);
    assert.equal(f.state.clicks, 2);
    assert.equal(f.state.captchaCalls, 2);
    assert.equal(f.state.visits.length, 1, 'only the fresh read-only login entry is reloaded');
  } finally { await f.manager.close(); }
});

test('reused Xiji captcha image does not cause another login submission', async () => {
  const f = fixture({ id: 'xiji', captcha: true,
    inspect: state => ({ ...signedOut, challengeType: 'text', captchaRejected: state.clicks > 0 }),
    solver: () => ({ filled: true, challengeKey: 'same-image', type: 'text' }),
  });
  try {
    assert.equal((await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 5000 })).authenticated, false);
    assert.equal(f.state.captchaCalls, 2);
    assert.equal(f.state.clicks, 1);
  } finally { await f.manager.close(); }
});

test('low-confidence first OCR refreshes once without submitting its guess', async () => {
  const f = fixture({ id: 'xiji', captcha: true,
    solver: state => ({ filled: state.captchaCalls > 1, challengeKey: `captcha-${state.captchaCalls}`, type: 'text', reason: '识别置信度不足' }),
  });
  try {
    assert.equal((await f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 5000 })).authenticated, true);
    assert.equal(f.state.captchaCalls, 2);
    assert.equal(f.state.clicks, 1);
    assert.equal(f.state.visits.length, 1);
  } finally { await f.manager.close(); }
});

test('closing authentication releases jobs and OCR without late password submission', async () => {
  const gate = deferred();
  const f = fixture({ inspect: () => gate.promise });
  const auth = f.manager.authenticate(f.platform, { navigate: false });
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.manager.close();
  gate.resolve({ authenticated: null, reason: '页面已关闭' });
  await auth;
  await closing;
  assert.equal(f.state.closed, true);
  assert.equal(f.state.clicks, 0);
  assert.equal(f.state.credentialReads, 0);
  assert.equal(f.state.ocrCloses, 1);
  assert.equal(f.manager.authJobs.size, 0);
  assert.equal(f.manager.sessions.size, 0);
});

test('closing during initial inspection rejects a late authenticated result', async () => {
  const gate = deferred();
  const f = fixture({ inspect: () => gate.promise });
  const auth = f.manager.authenticate(f.platform, { navigate: false });
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.manager.close();
  gate.resolve(signedIn);
  const result = await auth;
  await closing;
  assert.equal(result.authenticated, null);
  assert.equal(f.session.authVerified, false);
  assert.equal(f.state.statuses.some(patch => patch.loginStatus === 'authenticated'), false);
  assert.equal(f.state.credentialReads, 0);
  assert.equal(f.state.clicks, 0);
  assert.equal(f.manager.authJobs.size, 0);
});

test('closing during post-submit inspection cannot turn a late result into success', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ inspect: state => {
    if (!state.clicks) return signedOut;
    entered.resolve();
    return gate.promise;
  } });
  const auth = f.manager.authenticate(f.platform, { navigate: false, timeoutMs: 4000 });
  await entered.promise;
  const closing = f.manager.close();
  gate.resolve(signedIn);
  const result = await auth;
  await closing;
  assert.equal(result.authenticated, null);
  assert.equal(f.session.authVerified, false);
  assert.equal(f.state.statuses.some(patch => patch.loginStatus === 'authenticated'), false);
  assert.equal(f.state.clicks, 1, 'there must not be another submission after closing');
  assert.equal(f.state.ocrCloses, 1);
  assert.equal(f.manager.authJobs.size, 0);
});

test('read-only verification of an interactive session never reads or fills credentials', async () => {
  for (const inspection of [signedIn, signedOut]) {
    const gate = deferred();
    const f = fixture({ inspect: () => gate.promise, captcha: true });
    f.session.interactive = true;
    try {
      const verification = f.manager.verifySession(f.platform, { navigate: true, waitMs: 0 });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.manager.isOpen(f.platform.id), true);
      assert.equal(f.session.probing, true, 'assist polling must be suspended while inspection is pending');
      assert.deepEqual(f.state.visits, [f.platform.syncUrl]);
      gate.resolve(inspection);
      assert.equal((await verification).authenticated, inspection.authenticated);
      assert.equal(f.session.probing, false);
      assert.equal(f.state.credentialReads, 0);
      assert.equal(f.state.captchaCalls, 0);
      assert.equal(f.state.clicks, 0);
      assert.equal(f.username.element.value, undefined);
      assert.equal(f.password.element.value, undefined);
      assert.deepEqual(f.password.element.events, []);
    } finally { gate.resolve(inspection); await f.manager.close(); }
  }
});
