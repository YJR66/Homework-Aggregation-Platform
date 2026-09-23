const VPN_HOST = 'vpn.neuq.edu.cn';
const CAS_PREFIX = '/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/';
const XIJI_PREFIX = '/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const HOSTS = {
  chaoxing: new Set(['i.chaoxing.com', 'passport2.chaoxing.com', 'passport.chaoxing.com', 'mooc1.chaoxing.com', 'mooc1-1.chaoxing.com', 'mooc1-2.chaoxing.com']),
  yuketang: new Set(['www.yuketang.cn', 'yuketang.cn']),
  pta: new Set(['pintia.cn', 'www.pintia.cn', 'passport.pintia.cn']),
};
const CREDENTIAL_ERROR = /(?:手机号\s*[/／]\s*超星号|用户名|用户账号|帐号|账号|账户|手机号|手机号码|学号)(?:\s*(?:和|或|与|及|\/|、)\s*密码)?\s*(?:输入)?\s*(?:错误|不正确|不匹配|不存在)|密码\s*(?:输入)?\s*(?:错误|不正确)|(?:invalid|incorrect)\s+(?:username\s+or\s+password|password)|(?:username\s+or\s+password|password)\s+is\s+(?:invalid|incorrect)/i;
const CAPTCHA_ERROR = /(?:图形|图片|图像)?验证码\s*(?:输入)?\s*(?:错误|不正确|有误|已?过期|已?失效)|(?:invalid|incorrect|expired)\s+captcha|captcha\s+(?:is\s+)?(?:invalid|incorrect|expired)/i;

function scope(id, value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (id !== 'xiji') return HOSTS[id]?.has(url.hostname) ? { url, stage: 'platform' } : null;
  if (url.hostname !== VPN_HOST) return null;
  if (url.pathname.startsWith(CAS_PREFIX)) return { url, stage: 'vpn' };
  if (url.pathname.startsWith(XIJI_PREFIX)) return { url, stage: 'platform' };
  if (['/', '/index', '/login'].includes(url.pathname)) return { url, stage: 'gateway' };
  return null;
}

function loginRoute(id, { url, stage }) {
  if (id === 'chaoxing') return /^passport\d*\.chaoxing\.com$/.test(url.hostname) && /^\/(?:login|fanyalogin)(?:\/|$)/.test(url.pathname);
  if (id === 'pta') return /^\/(?:auth\/)?login\/?$/.test(url.pathname);
  if (id === 'yuketang') return /^\/(?:v2\/web\/)?login\/?$/.test(url.pathname);
  return id === 'xiji' && (stage === 'vpn' && url.pathname === `${CAS_PREFIX}login` || stage === 'gateway' && url.pathname === '/login');
}

function validXijiCourseLink(value, base) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value, base); } catch { return false; }
  // WebVPN can retain a narrowly observed original-host link getter.
  const accepted = scope('xiji', url.href)?.stage === 'platform' && url.pathname === `${XIJI_PREFIX}courselist.jsp`
    || url.origin === 'https://ccelab.neuq.edu.cn' && url.pathname === '/courselist.jsp';
  return Boolean(accepted && !url.username && !url.password && /^\d+$/.test(url.searchParams.get('courseID') || ''));
}

function result(authenticated, stage, reason, extra = {}) {
  return { authenticated, stage: stage || null, challengeType: null, reason, invalidCredentials: false, captchaRejected: false, ...extra };
}

/**
 * Pure three-state interpretation of visible DOM evidence. A protected route,
 * HTTP success, cookie, course shell, or absence of a password is not enough.
 * Snapshots contain no input values; reasons never echo page text or URLs.
 */
export function normalizeLoginSnapshot(snapshot = {}, platform) {
  const id = typeof platform === 'string' ? platform : platform?.id;
  const top = scope(id, snapshot.url);
  if (!top) return result(null, null, '当前页面不是该平台的登录页或课程页。');
  const frames = (Array.isArray(snapshot.frames) ? snapshot.frames : [snapshot])
    .filter(frame => frame?.visible !== false)
    .map(frame => ({ ...frame, scope: scope(id, frame.url) }))
    .filter(frame => frame.scope);
  for (const frame of frames) {
    const authContext = frame.hasPassword === true || frame.hasLoginModal === true || frame.hasLoginControl === true || frame.loginRequired === true || loginRoute(id, frame.scope);
    if (!authContext && !frame.hasChallenge) continue;
    const text = String(frame.errorText || '');
    const invalidCredentials = authContext && CREDENTIAL_ERROR.test(text);
    const captchaRejected = CAPTCHA_ERROR.test(text);
    const challengeType = ['text', 'slider', 'click', 'sms', 'qr'].includes(frame.challengeType) ? frame.challengeType : null;
    if (invalidCredentials) return result(false, frame.scope.stage, '平台提示账号或密码有误。', { challengeType, invalidCredentials, captchaRejected });
    if (captchaRejected) return result(false, frame.scope.stage, '验证码错误或已过期。', { challengeType, captchaRejected });
    if (frame.hasChallenge || challengeType) return result(false, frame.scope.stage, '请完成登录验证。', { challengeType });
    if (authContext) return result(false, frame.scope.stage, '请登录。');
  }
  if (snapshot.readFailed || frames.some(frame => frame.readFailed)) return result(null, top.stage, '登录页面未读完，暂无法确认登录状态。');
  for (const frame of frames) {
    if (!['interactive', 'complete'].includes(frame.readyState) || frame.loading === true) continue;
    const { url, stage } = frame.scope;
    if (id === 'chaoxing' && /^mooc1(?:-[12])?\.chaoxing\.com$/.test(url.hostname)
      && url.pathname === '/visit/interaction' && frame.hasCourseList === true) return result(true, 'platform', '已进入学习通“我学的课”。');
    if (id === 'yuketang' && /^\/v2\/web\/index\/?$/.test(url.pathname) && frame.hasStudentTab === true) return result(true, 'platform', '已进入雨课堂“我听的课”。');
    if (id === 'pta' && url.hostname === 'pintia.cn' && /^\/problem-sets\/active\/?$/.test(url.pathname) && frame.hasPtaActiveTab === true) return result(true, 'platform', '已进入 PTA 当前题目集。');
    if (id === 'xiji' && stage === 'platform' && (frame.hasXijiMain === true
      || (frame.xijiCourseLinks || []).some(href => validXijiCourseLink(href, frame.url)))) return result(true, 'platform', '已进入希冀课程页。');
  }
  if (id === 'xiji' && frames.some(frame => frame.scope.stage === 'gateway' && frame.hasVpnPortal === true && ['interactive', 'complete'].includes(frame.readyState))) {
    return result(false, 'gateway', '学校 VPN 已登录，希冀登录尚未确认。');
  }
  // An expired Xiji platform session can serve HTTP 200 with a completely empty
  // main.jsp instead of redirecting to login. This is not logged-out evidence:
  // it only permits the caller to read the known login entry and inspect again.
  if (id === 'xiji' && top.url.pathname === `${XIJI_PREFIX}main.jsp`
    && frames.some(frame => frame.url === snapshot.url && frame.readyState === 'complete'
      && frame.emptyDocument === true && frame.loading !== true)) {
    return result(null, 'platform', '希冀页面为空，正在检查登录状态。', { blankProtectedPage: true });
  }
  return result(null, top.stage, '课程页面未加载完，暂无法确认登录状态。');
}

function readVisibleDocument() {
  const visible = element => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const text = element => String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  const body = document.body?.innerText || '';
  const hasPassword = all('input[type="password"]').length > 0;
  const controls = all('button,a,[role="button"],input[type="submit"],img[alt]');
  const controlLabel = element => element.getAttribute('aria-label') || element.getAttribute('alt') || element.value || text(element);
  const hasLoginControl = controls.some(element => /^(?:登\s*录|立即登录|账号密码登录|扫码登录|微信扫码登录|CAS统一身份认证登录|login|log in|sign in)$/i.test(controlLabel(element).trim()));
  const hasLoginModal = all('[role="dialog"],.el-dialog,.ant-modal,.modal,.login-modal,.login-dialog').some(element => /登录|log in|sign in/i.test(text(element)));
  const loginRequired = all('p,span,div,h1,h2').some(element => element.children.length === 0 && /^(?:请先登录|登录已过期|会话已过期|请重新登录|扫码登录|微信扫码登录|请使用微信扫码登录)[。！!]?$/i.test(text(element)));
  const errors = all('[role="alert"],.el-message--error,.el-notification.error,.login-error,.error-msg,.error-message,.form-error,#errorMsg,#errorTip,#errormsg,#showErrorTip,#tips,.tips');
  const errorText = errors.map(text).filter(Boolean).join('\n').slice(0, 4000)
    || (hasPassword || hasLoginModal || hasLoginControl || loginRequired ? body.slice(0, 12000) : '');
  const captchaInputs = all('input[placeholder*="验证码"],input[name*="captcha" i],input[id*="captcha" i],input[name="verifyCode"],input[name="captchaResponse"]');
  const captchaUi = all('[class*="geetest"],[class*="captcha" i],[id*="captcha" i],[class*="yidun"],[class*="slider-verification"],iframe[src*="captcha" i],iframe[src*="verify" i]');
  const challengeText = captchaUi.map(text).join(' ');
  const smsInputs = captchaInputs.some(element => /短信|手机验证码|sms|mobile/i.test([element.name, element.id, element.placeholder, text(element.parentElement)].join(' ')));
  const qr = all('img[alt*="二维码"],img[alt*="扫码"],[id*="qrcode" i],[class*="qrcode" i],canvas[aria-label*="二维码"]');
  const hasQr = qr.length > 0 && /扫码.{0,8}登录|扫描.{0,12}二维码|微信.{0,6}登录/.test(body);
  let challengeType = null;
  if (smsInputs) challengeType = 'sms';
  else if (captchaUi.length && /(?:按|请)?(?:顺序|依次|依序).{0,8}(?:点|选择)|请点击|点选|点击.{0,12}(?:文字|字符|汉字|图片|图中)/.test(challengeText)) challengeType = 'click';
  else if (all('.geetest_slider_button,.yidun_slider,[class*="slider-verification"],[role="slider"][aria-label*="验证"]').length || captchaUi.length && /拖动.{0,12}(?:滑块|拼图)|滑动.{0,12}(?:验证|滑块)|向右滑动/.test(challengeText)) challengeType = 'slider';
  else if (captchaInputs.length) challengeType = 'text';
  else if (hasQr) challengeType = 'qr';
  const hasChallenge = captchaInputs.length > 0 || hasQr || captchaUi.some(element => element.tagName === 'IFRAME' || /验证|拖动|滑动|点选|点击/.test(text(element)));
  const tab = all('#tab-student')[0];
  const ptaTab = all('#tab-active')[0];
  return {
    readyState: document.readyState, hasPassword, hasLoginModal, hasLoginControl, loginRequired, errorText,
    emptyDocument: Boolean(document.body && document.body.childElementCount === 0 && !document.body.textContent.trim()),
    hasChallenge: Boolean(hasChallenge || challengeType), challengeType,
    loading: all('[aria-busy="true"],.el-loading-mask,.loading-mask,.rain-loading').length > 0,
    hasCourseList: all('#courseList.course-list,#courseList').length > 0 && /我学的课/.test(body),
    hasStudentTab: Boolean(tab), hasPtaActiveTab: Boolean(ptaTab?.classList.contains('active')),
    hasXijiMain: all('#activeActionDIV').length > 0 && all('#courseDropdown').length > 0,
    xijiCourseLinks: all('a[href*="courselist.jsp?courseID="]').map(element => element.getAttribute('href')),
    hasVpnPortal: /欢迎您/.test(body) && /校内应用/.test(body) || controls.some(element => /^(?:退出登录|退出系统|注销登录|logout|sign out)$/i.test(controlLabel(element).trim())),
  };
}

async function frameVisible(frame, mainFrame) {
  for (let current = frame; current && current !== mainFrame; current = current.parentFrame()) {
    const element = await current.frameElement();
    try { if (!await element.isVisible()) return false; }
    finally { await element.dispose?.(); }
  }
  return true;
}

/** Inspect visible trusted documents only. No navigation, filling or clicks. */
export async function inspectLoginState(page, platform) {
  const id = typeof platform === 'string' ? platform : platform?.id;
  let url;
  try { url = page.url(); } catch { return result(null, null, '页面已关闭或不可读取。'); }
  if (!scope(id, url)) return normalizeLoginSnapshot({ url }, platform);
  const snapshot = { url, frames: [] };
  try {
    const frames = page.frames();
    const mainFrame = page.mainFrame?.() || frames[0];
    for (const frame of frames) {
      const frameUrl = frame.url();
      if (!scope(id, frameUrl)) continue;
      try {
        if (!await frameVisible(frame, mainFrame)) continue;
        const evidence = await frame.evaluate(readVisibleDocument);
        if (frame.url() !== frameUrl || page.url() !== url) { snapshot.readFailed = true; continue; }
        snapshot.frames.push({ ...evidence, url: frameUrl, visible: true });
      } catch { snapshot.readFailed = true; }
    }
  } catch { snapshot.readFailed = true; }
  if (page.url() !== url) snapshot.readFailed = true;
  return normalizeLoginSnapshot(snapshot, platform);
}
