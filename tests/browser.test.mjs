import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedVpnPortal, authenticationStage, BrowserManager, credentialsForStage, trustedAuthFormAction, trustedAuthUrl, xijiBlankMainEntry } from '../server/browser.mjs';

test('authentication accepts exact HTTPS origins only', () => {
  assert.equal(trustedAuthUrl('chaoxing', 'https://passport2.chaoxing.com/login'), true);
  assert.equal(trustedAuthUrl('yuketang', 'https://www.yuketang.cn/web'), true);
  assert.equal(trustedAuthUrl('pta', 'https://pintia.cn/auth/login'), true);
  for (const url of [
    'http://passport2.chaoxing.com/login',
    'https://passport2.chaoxing.com.evil.test/login',
    'https://evil.test/passport2.chaoxing.com/login',
    'https://passport2.chaoxing.com:8443/login',
    'https://user:password@passport2.chaoxing.com/login',
    'javascript:alert(1)', 'not-a-url',
  ]) assert.equal(trustedAuthUrl('chaoxing', url), false, url);
  assert.equal(trustedAuthUrl('unknown', 'https://pintia.cn/'), false);
  assert.equal(trustedAuthUrl('pta', 'https://www.yuketang.cn/'), false);
});

test('NEUQ VPN keeps gateway, school CAS and Xiji credential scopes separate', () => {
  const cas = 'https://vpn.neuq.edu.cn/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/login';
  const xiji = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/indexcs/simple.jsp?loginErr=0';
  assert.equal(authenticationStage('xiji', 'https://vpn.neuq.edu.cn/login?cas_login=true'), 'gateway');
  assert.equal(authenticationStage('xiji', cas), 'vpn');
  assert.equal(authenticationStage('xiji', xiji), 'platform');
  assert.equal(authenticationStage('xiji', 'https://vpn.neuq.edu.cn/https/unrelated-proxied-host/login'), null);
  assert.equal(authenticationStage('xiji', cas.replace('vpn.neuq.edu.cn', 'vpn.neuq.edu.cn.evil.test')), null);
  assert.equal(authenticationStage('xiji', xiji.replace('/indexcs/', '/../evil/')), null);
});

test('credential selection never falls back from school CAS to platform password', () => {
  const credentials = { username: 'platform-user', password: 'platform-secret', vpnUsername: 'school-user', vpnPassword: 'school-secret' };
  assert.deepEqual(credentialsForStage(credentials, 'vpn'), { username: 'school-user', password: 'school-secret' });
  assert.deepEqual(credentialsForStage(credentials, 'platform'), { username: 'platform-user', password: 'platform-secret' });
  assert.deepEqual(credentialsForStage(credentials, 'gateway'), { username: '', password: '' });
  assert.deepEqual(credentialsForStage({ username: 'platform-user', password: 'platform-secret' }, 'vpn'), { username: '', password: '' });
});

test('Xiji blank-page recovery is limited to exact known routes and positive empty-document evidence', () => {
  const root = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
  const platform = { id: 'xiji', entryUrl: `${root}indexcs/simple.jsp?loginErr=0` };
  const inspection = { authenticated: null, blankProtectedPage: true };
  assert.equal(xijiBlankMainEntry(platform, `${root}main.jsp`, inspection), platform.entryUrl);
  for (const current of [`${root}main.jsp?next=login`, `${root}main.jsp#login`, `${root}courselist.jsp`, root.replace('vpn.neuq.edu.cn', 'evil.test') + 'main.jsp']) {
    assert.equal(xijiBlankMainEntry(platform, current, inspection), null);
  }
  for (const entryUrl of [`${root}indexcs/simple.jsp?next=other`, `${root}login/loginproc.jsp`, `${root}indexcs/simple.jsp#other`, 'https://vpn.neuq.edu.cn/login']) {
    assert.equal(xijiBlankMainEntry({ ...platform, entryUrl }, `${root}main.jsp`, inspection), null);
  }
  for (const evidence of [{ authenticated: null }, { authenticated: false, blankProtectedPage: true }, { authenticated: true, blankProtectedPage: true }]) {
    assert.equal(xijiBlankMainEntry(platform, `${root}main.jsp`, evidence), null);
  }
  assert.equal(xijiBlankMainEntry({ ...platform, id: 'yuketang' }, `${root}main.jsp`, inspection), null);
});

test('existing sessions are reused without navigation or loading credentials', async () => {
  let credentialReads = 0;
  const manager = new BrowserManager({ dataDir: './unused-test-profile', getCredentials: async () => { credentialReads++; return {}; } });
  const page = { isClosed: () => false };
  const context = { pages: () => [page], close: async () => {} };
  manager.sessions.set('pta', { context, page, interactive: true, closed: false });
  assert.equal(manager.isOpen('pta'), true);
  assert.equal(manager.isOpen('xiji'), false);
  assert.deepEqual(await manager.getSession({ id: 'pta', entryUrl: 'https://pintia.cn/' }), { context, page });
  assert.deepEqual(await manager.getSession({ id: 'pta', entryUrl: 'https://pintia.cn/' }, { interactive: true }), { context, page });
  assert.equal(credentialReads, 0);
  await manager.close();
  assert.equal(manager.isOpen('pta'), false);
});

test('unknown platform ids, unsafe entry URLs and closed managers fail before browser launch', async () => {
  const manager = new BrowserManager({ dataDir: './unused-test-profile' });
  await assert.rejects(manager.getSession({ id: '../pta', entryUrl: 'https://pintia.cn/' }), /不支持/);
  await assert.rejects(manager.getSession({ id: 'pta', entryUrl: 'https://pintia.cn.evil.test/' }), /受信任/);
  await manager.close();
  await assert.rejects(manager.getSession({ id: 'pta', entryUrl: 'https://pintia.cn/' }), /已关闭/);
});

const portalEvidence = {
  url: 'https://vpn.neuq.edu.cn/', readyState: 'complete',
  hasLoginForm: false, hasLoginControl: false, hasChallenge: false, hasLogoutControl: true,
};

test('VPN return requires a loaded exact portal and affirmative authenticated UI', () => {
  assert.equal(authenticatedVpnPortal(portalEvidence), true);
  assert.equal(authenticatedVpnPortal({ ...portalEvidence, url: 'https://vpn.neuq.edu.cn/index' }), true);
  assert.equal(authenticatedVpnPortal(), false);
  for (const patch of [
    { url: 'https://vpn.neuq.edu.cn/login' },
    { url: 'https://vpn.neuq.edu.cn/index/other' },
    { url: 'https://vpn.neuq.edu.cn/index?ticket=not-finished' },
    { url: 'https://vpn.neuq.edu.cn/#/login' },
    { url: 'https://vpn.neuq.edu.cn.evil.test/' },
    { url: 'http://vpn.neuq.edu.cn/' },
    { url: 'https://vpn.neuq.edu.cn:8443/' },
    { url: 'https://user:secret@vpn.neuq.edu.cn/' },
    { readyState: 'loading' }, { hasLogoutControl: false },
    { hasLoginForm: true }, { hasLoginControl: true }, { hasChallenge: true },
    { hasLoginForm: undefined },
  ]) assert.equal(authenticatedVpnPortal({ ...portalEvidence, ...patch }), false, JSON.stringify(patch));
});

function mockedPortalSession(evidence = portalEvidence, attempts = ['vpn']) {
  const platform = { id: 'xiji', entryUrl: 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/indexcs/simple.jsp?loginErr=0' };
  const visits = [];
  let url = evidence.url;
  const page = {
    url: () => url, isClosed: () => false, frames: () => [],
    bringToFront: async () => {}, evaluate: async () => ({ ...evidence, url }),
    goto: async (target) => { visits.push(target); url = target; },
  };
  const context = { pages: () => [page], close: async () => {} };
  const session = { platform, page, context, interactive: true, closed: false, attempts: new Set(attempts), filled: new Set(), assisting: false, lastStatus: '' };
  const manager = new BrowserManager({ dataDir: './unused-test-profile' });
  manager.sessions.set('xiji', session);
  return { manager, platform, session, visits, setUrl: (nextUrl) => { url = nextUrl; } };
}

test('successful CAS portal resumes the Xiji entry once, without repeated redirects', async () => {
  const fixture = mockedPortalSession();
  await fixture.manager.openLogin(fixture.platform);
  assert.deepEqual(fixture.visits, [fixture.platform.entryUrl]);
  assert.equal(fixture.session.attempts.has('portal-resume'), true);
  fixture.setUrl(portalEvidence.url);
  await fixture.manager.openLogin(fixture.platform);
  assert.equal(fixture.visits.length, 1);
  await fixture.manager.close();
});

test('CAS return does not interrupt pending authentication or navigate without a CAS stage', async () => {
  for (const [evidence, attempts] of [
    [{ ...portalEvidence, hasChallenge: true }, ['vpn']],
    [{ ...portalEvidence, hasLoginForm: true }, ['vpn']],
    [{ ...portalEvidence, hasLogoutControl: false }, ['vpn']],
    [portalEvidence, []],
  ]) {
    const fixture = mockedPortalSession(evidence, attempts);
    await fixture.manager.openLogin(fixture.platform);
    assert.equal(fixture.visits.length, 0);
    assert.equal(fixture.session.attempts.has('portal-resume'), false);
    await fixture.manager.close();
  }
});

test('portal return does not navigate after a concurrent authentication-page redirect', async () => {
  const fixture = mockedPortalSession();
  fixture.session.page.evaluate = async () => {
    fixture.setUrl('https://vpn.neuq.edu.cn/login?cas_login=true');
    return portalEvidence;
  };
  await fixture.manager.openLogin(fixture.platform);
  assert.equal(fixture.visits.length, 0);
  await fixture.manager.close();
});

test('WebVPN CAS allows only its exact known action shim within the school CAS scope', () => {
  const cas = 'https://vpn.neuq.edu.cn/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/login';
  const service = '?service=https%3A%2F%2Fvpn.neuq.edu.cn%2Flogin%3Fcas_login%3Dtrue';
  for (const action of ['/authserver/login', `/authserver/login${service}`, `http://ids.neuq.edu.cn/authserver/login${service}`]) {
    assert.equal(trustedAuthFormAction('xiji', cas, action), true, action);
  }
  for (const action of [
    'http://ids.neuq.edu.cn.evil.test/authserver/login',
    'http://ids.neuq.edu.cn:8080/authserver/login',
    'http://user:secret@ids.neuq.edu.cn/authserver/login',
    'http://ids.neuq.edu.cn/authserver/logout',
    '/authserver/login?service=https://evil.test/login',
    '/authserver/login?service=https://vpn.neuq.edu.cn/login?cas_login=false',
    '/authserver/login?service=http://vpn.neuq.edu.cn/login?cas_login=true',
    '/authserver/other', 'javascript:alert(1)',
  ]) assert.equal(trustedAuthFormAction('xiji', cas, action), false, action);
  const xiji = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/indexcs/simple.jsp';
  assert.equal(trustedAuthFormAction('xiji', xiji, 'http://ids.neuq.edu.cn/authserver/login'), false);
  assert.equal(trustedAuthFormAction('xiji', 'https://vpn.neuq.edu.cn/login', '/authserver/login'), false);
  assert.equal(trustedAuthFormAction('pta', 'https://pintia.cn/auth/login', '/auth/login'), true);
  assert.equal(trustedAuthFormAction('pta', 'https://pintia.cn/auth/login', 'https://evil.test/login'), false);
});

function emptyLocator() {
  return { count: async () => 0, isVisible: async () => false };
}

function mockLoginManager(platform, frame, credentials = {}) {
  const page = { url: () => platform.entryUrl, isClosed: () => false, frames: () => [frame], bringToFront: async () => {} };
  const context = { pages: () => [page], close: async () => {} };
  const session = { platform, page, context, interactive: true, closed: false, attempts: new Set(), filled: new Set(), assisting: false, lastStatus: '' };
  const statuses = [];
  const manager = new BrowserManager({ dataDir: './unused-test-profile', getCredentials: async () => credentials, onStatus: (_id, status) => statuses.push(status) });
  manager.sessions.set(platform.id, session);
  return { manager, session, statuses };
}

test('PTA opens its public-page login modal only once without submitting an unknown form', async () => {
  let clicks = 0;
  const platform = { id: 'pta', entryUrl: 'https://pintia.cn/problem-sets' };
  const button = { count: async () => 1, isVisible: async () => true, click: async () => { clicks++; } };
  const frame = { url: () => platform.entryUrl, locator: emptyLocator, getByRole: (role) => role === 'button' ? button : emptyLocator() };
  const { manager, session } = mockLoginManager(platform, frame);
  await manager.openLogin(platform);
  await manager.openLogin(platform);
  assert.equal(clicks, 1);
  assert.equal(session.attempts.has('login-modal'), true);
  assert.equal(session.attempts.has('platform'), false);
  await manager.close();
});

test('Rain Classroom fields receive keyup and blur validation, and its enabled div login is submitted once', async () => {
  const platform = { id: 'yuketang', entryUrl: 'https://www.yuketang.cn/web' };
  const inputs = [];
  class FakeInput {
    constructor() { this.events = []; this.ownerDocument = { defaultView: view }; inputs.push(this); }
    set value(value) { this.stored = value; }
    get value() { return this.stored; }
    focus() { this.events.push('focus'); }
    blur() { this.events.push('blur'); }
    dispatchEvent(event) { this.events.push(event.type); return true; }
  }
  class FakeEvent { constructor(type) { this.type = type; } }
  const view = { location: new URL(platform.entryUrl), HTMLInputElement: FakeInput, Event: FakeEvent, KeyboardEvent: FakeEvent };
  function inputLocator() {
    const input = new FakeInput();
    const locator = { count: async () => 1, nth: () => locator, isVisible: async () => true, evaluate: async (callback, args) => callback(input, args) };
    return locator;
  }
  const username = inputLocator();
  const password = inputLocator();
  let clicks = 0;
  const loginElement = { classList: { contains: () => false }, getAttribute: () => null, hasAttribute: () => false };
  const login = {
    count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
    filter: () => login, evaluate: async (callback) => callback(loginElement), click: async () => { clicks++; },
  };
  const frame = {
    url: () => platform.entryUrl, getByRole: emptyLocator,
    locator: (selector) => selector === '#phone' ? username : selector === '#pwd' ? password : selector === 'div.submit-btn.login-btn' ? login : emptyLocator(),
  };
  const credentials = { username: '18900000000', password: 'fake-password-only' };
  const { manager } = mockLoginManager(platform, frame, credentials);
  await manager.openLogin(platform);
  await manager.openLogin(platform);
  assert.equal(clicks, 1);
  assert.equal(inputs[0].value, credentials.username);
  assert.equal(inputs[1].value, credentials.password);
  for (const input of inputs) assert.deepEqual(input.events, ['focus', 'input', 'change', 'keyup', 'blur']);
  await manager.close();
});
