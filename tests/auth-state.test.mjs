import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectLoginState, normalizeLoginSnapshot } from '../server/auth-state.mjs';

const CAS = 'https://vpn.neuq.edu.cn/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/login';
const XIJI = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const CHAOXING = 'https://i.chaoxing.com/';
const COURSE_FRAME = 'https://mooc1-2.chaoxing.com/visit/interaction?type=personal';
const RAIN = 'https://www.yuketang.cn/v2/web/index';
const PTA = 'https://pintia.cn/problem-sets/active';
const ready = patch => ({ readyState: 'complete', ...patch });
const read = (id, snapshot) => normalizeLoginSnapshot(snapshot, { id });

test('login probes require positive personal-area evidence on exact protected routes', () => {
  assert.equal(read('chaoxing', { url: CHAOXING, frames: [ready({ url: CHAOXING }), ready({ url: COURSE_FRAME, hasCourseList: true })] }).authenticated, true);
  assert.equal(read('yuketang', ready({ url: RAIN, hasStudentTab: true })).authenticated, true);
  assert.equal(read('pta', ready({ url: PTA, hasPtaActiveTab: true })).authenticated, true);
  assert.equal(read('xiji', ready({ url: `${XIJI}main.jsp`, hasXijiMain: true })).authenticated, true);
  assert.equal(read('xiji', ready({ url: `${XIJI}courselist.jsp`, xijiCourseLinks: ['courselist.jsp?courseID=43'] })).authenticated, true);
  for (const [id, snapshot] of [
    ['chaoxing', ready({ url: CHAOXING, hasCourseList: true })],
    ['yuketang', ready({ url: 'https://www.yuketang.cn/web', hasStudentTab: true })],
    ['pta', ready({ url: 'https://pintia.cn/problem-sets', hasPtaActiveTab: true })],
    ['xiji', ready({ url: `${XIJI}courselist.jsp`, xijiCourseLinks: ['https://evil.test/courselist.jsp?courseID=43'] })],
  ]) assert.equal(read(id, snapshot).authenticated, null);
});

test('malicious hosts, credentials, non-HTTPS URLs and unrelated VPN prefixes are not trusted', () => {
  for (const url of [
    'https://www.yuketang.cn.evil.test/v2/web/index', 'http://www.yuketang.cn/v2/web/index',
    'https://user:secret@www.yuketang.cn/v2/web/index', 'https://www.yuketang.cn:8443/v2/web/index',
    'https://evil.test/?next=https://www.yuketang.cn/v2/web/index',
  ]) assert.equal(read('yuketang', ready({ url, hasStudentTab: true, hasPassword: true })).authenticated, null);
  assert.equal(read('xiji', ready({ url: 'https://vpn.neuq.edu.cn/https/unrelated/main.jsp', hasXijiMain: true, hasPassword: true })).authenticated, null);
  assert.equal(read('xiji', ready({ url: `${XIJI}../main.jsp`, hasXijiMain: true })).authenticated, null);
});

test('protected shells, loading and failed document reads remain unknown', () => {
  for (const patch of [{}, { readyState: 'loading', hasStudentTab: true }, { loading: true, hasStudentTab: true }, { readFailed: true, hasStudentTab: true }]) {
    assert.equal(read('yuketang', ready({ url: RAIN, ...patch })).authenticated, null);
  }
  assert.equal(read('pta', ready({ url: PTA, hasPtaActiveTab: false })).authenticated, null);
});

test('only a completely loaded empty Xiji main page advertises read-only entry recovery', () => {
  const blank = ready({ url: `${XIJI}main.jsp`, emptyDocument: true });
  const result = read('xiji', blank);
  assert.equal(result.authenticated, null, 'blank page is not evidence of logout');
  assert.equal(result.blankProtectedPage, true);
  for (const patch of [{ emptyDocument: false }, { readyState: 'loading' }, { readyState: 'interactive' }, { loading: true }, { readFailed: true }, { url: `${XIJI}indexcs/simple.jsp` }]) {
    assert.notEqual(read('xiji', { ...blank, ...patch }).blankProtectedPage, true);
  }
  assert.notEqual(read('yuketang', ready({ url: RAIN, emptyDocument: true })).blankProtectedPage, true);
});

test('visible login evidence takes precedence over a preserved authenticated shell', () => {
  const state = read('yuketang', ready({ url: RAIN, hasStudentTab: true, hasLoginModal: true }));
  assert.equal(state.authenticated, false);
  assert.equal(state.invalidCredentials, false);
  assert.equal(state.challengeType, null);
  assert.equal(read('chaoxing', ready({ url: 'https://passport2.chaoxing.com/login' })).authenticated, false);
  assert.equal(read('pta', ready({ url: PTA, hasPtaActiveTab: true, hasPassword: true })).authenticated, false);
});

test('credential failures require concrete account/password error phrases', () => {
  for (const errorText of ['手机号/超星号或密码错误', '用户名或密码不正确', '账号不存在', '密码错误', 'Invalid username or password']) {
    const state = read('chaoxing', ready({ url: 'https://passport2.chaoxing.com/login', hasPassword: true, errorText }));
    assert.equal(state.authenticated, false);
    assert.equal(state.invalidCredentials, true, errorText);
    assert.equal(state.captchaRejected, false);
    assert.ok(!state.reason.includes(errorText), 'raw page text is not reflected');
  }
  for (const errorText of ['网络错误', '请求失败', '服务器异常', '请检查登录信息', '验证码错误']) {
    assert.equal(read('yuketang', ready({ url: RAIN, hasPassword: true, errorText })).invalidCredentials, false, errorText);
  }
  assert.equal(read('yuketang', ready({ url: RAIN, hasStudentTab: true, errorText: '课程说明：账号或密码错误的处理方法' })).authenticated, true);
});

test('captcha rejection and five challenge types are distinct from bad credentials', () => {
  for (const challengeType of ['text', 'slider', 'click', 'sms', 'qr']) {
    const state = read('yuketang', ready({ url: RAIN, hasPassword: true, hasChallenge: true, challengeType }));
    assert.equal(state.authenticated, false);
    assert.equal(state.challengeType, challengeType);
    assert.equal(state.invalidCredentials, false);
  }
  for (const errorText of ['验证码错误', '图形验证码已过期', '验证码不正确']) {
    const state = read('xiji', ready({ url: `${XIJI}indexcs/simple.jsp`, hasPassword: true, hasChallenge: true, challengeType: 'text', errorText }));
    assert.equal(state.captchaRejected, true);
    assert.equal(state.invalidCredentials, false);
  }
});

test('hidden trusted challenge frames cannot override a verified personal page', () => {
  assert.equal(read('yuketang', { url: RAIN, frames: [
    ready({ url: RAIN, hasStudentTab: true }),
    ready({ url: 'https://www.yuketang.cn/login', visible: false, hasPassword: true, hasChallenge: true, challengeType: 'text' }),
  ] }).authenticated, true);
});

test('VPN, school CAS and Xiji platform stages are distinguished', () => {
  const portal = read('xiji', ready({ url: 'https://vpn.neuq.edu.cn/', hasVpnPortal: true }));
  assert.equal(portal.authenticated, false);
  assert.equal(portal.stage, 'gateway');
  assert.match(portal.reason, /希冀登录尚未确认/);
  assert.equal(read('xiji', ready({ url: 'https://vpn.neuq.edu.cn/' })).authenticated, null);
  assert.equal(read('xiji', ready({ url: CAS, hasPassword: true })).stage, 'vpn');
  assert.equal(read('xiji', ready({ url: `${XIJI}indexcs/simple.jsp`, hasPassword: true })).stage, 'platform');
});

test('inspectLoginState does not inspect untrusted documents or navigate', async () => {
  let reads = 0;
  const page = { url: () => 'https://evil.test/', frames: () => { reads++; throw new Error('must not inspect'); } };
  assert.equal((await inspectLoginState(page, { id: 'pta' })).authenticated, null);
  assert.equal(reads, 0);
});

test('document navigation races invalidate positive snapshots', async () => {
  let current = RAIN;
  const frame = { url: () => current, evaluate: async () => { current = 'https://www.yuketang.cn/login'; return ready({ hasStudentTab: true }); } };
  const page = { url: () => current, frames: () => [frame], mainFrame: () => frame };
  assert.equal((await inspectLoginState(page, { id: 'yuketang' })).authenticated, null);
});

test('offline real DOM probes respect visibility, nested courses and challenge distinctions', async t => {
  const executablePath = [
    process.env.HOMEWORK_BROWSER_PATH,
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    chromium.executablePath(),
  ].find(value => value && existsSync(value));
  if (!executablePath) return t.skip('没有本机 Chromium，跳过离线 DOM fixture');
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const routes = new Map();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: routes.get(route.request().url()) || '<p>离线 fixture</p>' }));
  const page = await context.newPage();
  async function inspect(url, html, id) {
    routes.set(url, html);
    await page.goto(url, { waitUntil: 'load' });
    return inspectLoginState(page, { id });
  }
  try {
    routes.set(COURSE_FRAME, '<h1>我学的课</h1><ul id="courseList" class="course-list"><li>离线测试课程</li></ul>');
    assert.equal((await inspect(CHAOXING, `<iframe id="frame_content" src="${COURSE_FRAME}"></iframe>`, 'chaoxing')).authenticated, true);
    assert.equal((await inspect(RAIN, '<div id="tab-student">我听的课</div><iframe style="display:none" src="https://captcha.example/verify"></iframe><div hidden id="captcha"><input id="captchaCode"></div>', 'yuketang')).authenticated, true);
    assert.equal((await inspect(RAIN, '<div id="tab-student">我听的课</div><div role="dialog">登录<input type="password"></div>', 'yuketang')).authenticated, false);
    assert.equal((await inspect(RAIN, '<div id="tab-student">我听的课</div><div aria-busy="true">正在加载</div>', 'yuketang')).authenticated, null);
    assert.equal((await inspect(PTA, '<button id="tab-active" class="active">当前题目集</button>', 'pta')).authenticated, true);
    assert.equal((await inspect(`${XIJI}courselist.jsp`, '<a href="courselist.jsp?courseID=43">C++程序设计</a>', 'xiji')).authenticated, true);
    const blankXiji = await inspect(`${XIJI}main.jsp`, '<html><head></head><body></body></html>', 'xiji');
    assert.equal(blankXiji.authenticated, null);
    assert.equal(blankXiji.blankProtectedPage, true);
    assert.notEqual((await inspect(`${XIJI}main.jsp`, '<p>正在加载课程</p>', 'xiji')).blankProtectedPage, true);
    assert.equal((await inspect('https://vpn.neuq.edu.cn/', '<h1>欢迎您</h1><p>校内应用</p>', 'xiji')).authenticated, false);
    const text = await inspect(`${XIJI}indexcs/simple.jsp`, '<input type="password"><input id="captchaCode"><div role="alert">验证码错误</div>', 'xiji');
    assert.equal(text.challengeType, 'text');
    assert.equal(text.captchaRejected, true);
    assert.equal(text.invalidCredentials, false);
    assert.equal((await inspect(RAIN, '<input type="password"><div class="geetest_panel">请依次点击图中的汉字</div>', 'yuketang')).challengeType, 'click');
    assert.equal((await inspect(RAIN, '<input type="password"><div class="geetest_slider_button">拖动滑块完成验证</div>', 'yuketang')).challengeType, 'slider');
    assert.equal((await inspect(RAIN, '<label>短信验证码<input placeholder="验证码"></label>', 'yuketang')).challengeType, 'sms');
    assert.equal((await inspect(RAIN, '<p>微信扫码登录</p><div class="qrcode">离线二维码占位</div>', 'yuketang')).challengeType, 'qr');
    const invalid = await inspect('https://passport2.chaoxing.com/login', '<input type="password"><div id="errorMsg">手机号/超星号或密码错误</div>', 'chaoxing');
    assert.equal(invalid.invalidCredentials, true);
  } finally { await browser.close(); }
});
