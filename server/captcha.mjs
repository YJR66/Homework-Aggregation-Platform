import { createHash } from 'node:crypto';

const VPN_ORIGIN = 'https://vpn.neuq.edu.cn';
const XIJI_PREFIX = '/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const CAS_PREFIX = '/http/77726476706e69737468656265737421f9f352d229357d41300d8db9d6562d/authserver/';
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HOSTS = { chaoxing: ['passport2.chaoxing.com', 'passport.chaoxing.com', 'i.chaoxing.com'], yuketang: ['www.yuketang.cn', 'yuketang.cn'], pta: ['pintia.cn', 'www.pintia.cn', 'passport.pintia.cn'] };

function trustedFrame(platformId, stage, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (platformId === 'xiji') return url.origin === VPN_ORIGIN && (stage === 'platform' ? url.pathname.startsWith(XIJI_PREFIX) : stage === 'vpn' && url.pathname.startsWith(CAS_PREFIX));
    return stage === 'platform' && Boolean(HOSTS[platformId]?.includes(url.hostname));
  } catch { return false; }
}

export function acceptableCaptchaRecognition(result, { length = 5 } = {}) {
  if (!result || ![4, 5, 6].includes(length) || typeof result.text !== 'string') return false;
  const text = result.text.replace(/\s/g, '');
  return new RegExp(`^[A-Za-z0-9]{${length}}$`).test(text)
    && Number.isFinite(result.confidence) && result.confidence >= 0.8 && result.confidence <= 1
    && Number.isFinite(result.minConfidence) && result.minConfidence >= 0.65 && result.minConfidence <= 1;
}

export function trustedXijiCaptcha(snapshot) {
  if (!snapshot || snapshot.kind !== 'text' || !trustedFrame('xiji', 'platform', snapshot.url)) return false;
  const url = new URL(snapshot.url);
  if (url.pathname !== `${XIJI_PREFIX}indexcs/simple.jsp`) return false;
  const input = snapshot.input;
  if (!input || input.id !== 'captchaCode' || !['text', ''].includes(input.type) || input.disabled || input.readOnly || !snapshot.form) return false;
  const validForm = action => {
    try {
      const target = new URL(action, snapshot.url);
      if (target.username || target.password || target.protocol !== 'https:' || target.port) return false;
      return (target.origin === VPN_ORIGIN && [XIJI_PREFIX + 'login/loginproc.jsp', '/login/loginproc.jsp'].includes(target.pathname))
        || (target.origin === 'https://ccelab.neuq.edu.cn' && target.pathname === '/login/loginproc.jsp');
    } catch { return false; }
  };
  if (!snapshot.form.rawAction || !validForm(snapshot.form.rawAction) || !validForm(snapshot.form.action)) return false;
  const img = snapshot.image;
  if (!img?.complete || img.width < 20 || img.height < 10 || img.width > 1000 || img.height > 500) return false;
  const validImage = value => {
    try {
      const source = new URL(value, snapshot.url);
      if (source.username || source.password || source.protocol !== 'https:' || source.port) return false;
      // The VPN shim exposes original-site getters, while currentSrc can be the
      // rewritten URL. Both are restricted to the one observed captcha endpoint.
      return (source.origin === VPN_ORIGIN && [XIJI_PREFIX + 'cgjiaoyan', '/cgjiaoyan'].includes(source.pathname))
        || (source.origin === 'https://ccelab.neuq.edu.cn' && source.pathname === '/cgjiaoyan');
    } catch { return false; }
  };
  return Boolean(img.rawSrc && img.src && validImage(img.rawSrc) && validImage(img.src) && (!img.currentSrc || validImage(img.currentSrc)));
}

// All checks and the final value write occur in one document. The mutation/load
// generation also catches refreshes that reuse the same image URL.
function captchaDomAction({ action, expected, value, token }) {
  const key = Symbol.for('courseflow.login-captcha-race-guard.v1');
  const cache = window[key] || (window[key] = { byInput: new WeakMap(), entries: new Map() });
  const release = id => {
    const entry = cache.entries.get(id);
    if (!entry) return;
    entry.observer.disconnect();
    entry.image.removeEventListener('load', entry.bump);
    entry.image.removeEventListener('error', entry.bump);
    cache.byInput.delete(entry.input); cache.entries.delete(id);
  };
  if (action === 'release') { release(token); return true; }
  const visible = element => Boolean(element?.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
  const input = document.querySelector('#captchaCode');
  const image = input?.nextElementSibling;
  if (!visible(input) || image?.tagName !== 'IMG' || !visible(image)) {
    if (action === 'fill') return false;
    const controls = [...document.querySelectorAll('input')].filter(visible);
    if (controls.some(e => /短信|手机验证码|sms|otp/i.test([e.placeholder, e.name, e.id].join(' ')))) return { kind: 'sms' };
    if ([...document.querySelectorAll('[class*="geetest_slider"],[class*="yidun_slider"],[class*="slider-verification"],.nc_scale')].some(visible)) return { kind: 'slider' };
    const challenges = [...document.querySelectorAll('[id*="captcha" i],[class*="captcha" i],[class*="verify" i],[class*="geetest" i]')].filter(visible);
    if (challenges.some(e => /依次点击|按顺序点击|点选|点击下图|选择图中/.test(e.innerText || ''))) return { kind: 'click' };
    if (challenges.length || controls.some(e => /验证码/.test(e.placeholder || ''))) return { kind: 'unknown' };
    return { kind: 'none' };
  }
  if (!input.form) return action === 'fill' ? false : { kind: 'unknown' };
  let entry = cache.byInput.get(input);
  if (!entry || entry.image !== image || entry.form !== input.form) {
    if (action === 'fill') return false;
    if (entry) release(entry.token);
    entry = { input, image, form: input.form, generation: 0, token: crypto.randomUUID() };
    entry.bump = () => { entry.generation++; };
    entry.observer = new MutationObserver(entry.bump);
    entry.observer.observe(image, { attributes: true, attributeFilter: ['src', 'srcset'] });
    image.addEventListener('load', entry.bump); image.addEventListener('error', entry.bump);
    cache.byInput.set(input, entry); cache.entries.set(entry.token, entry);
  }
  if (entry.observer.takeRecords().length) entry.generation++;
  const snapshot = { kind: 'text', url: location.href, token: entry.token, generation: entry.generation,
    input: { id: input.id, name: input.name, type: input.type, disabled: input.disabled, readOnly: input.readOnly, hasValue: Boolean(input.value) },
    form: { id: input.form.id, name: input.form.name, rawAction: input.form.getAttribute('action'), action: input.form.action },
    image: { rawSrc: image.getAttribute('src'), src: image.src, currentSrc: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight, complete: image.complete } };
  if (action !== 'fill') return snapshot;
  if (JSON.stringify(snapshot) !== JSON.stringify(expected) || !input.isConnected || !image.isConnected || input.value) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

const digest = data => createHash('sha256').update(data).digest('hex');
const answer = (type, reason, extra = {}) => ({ handled: type !== 'none', filled: false, type: type === 'none' ? 'unknown' : type, reason, ...extra });

/** Local, in-memory OCR for the one verified text-captcha DOM. Never submits. */
export async function solveTextCaptcha({ frame, platformId, stage, ocr }) {
  if (!frame || !trustedFrame(platformId, stage, frame.url())) return answer('none', '验证码不在平台登录页。');
  let snapshot, challengeKey;
  try {
    snapshot = await frame.evaluate(captchaDomAction, { action: 'inspect' });
    const type = ['text', 'slider', 'click', 'sms'].includes(snapshot?.kind) ? snapshot.kind : 'unknown';
    if (snapshot?.kind === 'none') return answer('none', '未发现验证码。');
    if (type !== 'text') return answer(type, type === 'sms' ? '请填写短信验证码。' : '此验证码需要手动完成。');
    if (platformId !== 'xiji' || stage !== 'platform' || !trustedXijiCaptcha(snapshot)) return answer('text', '验证码来源无法确认，未自动填写。');
    if (snapshot.input.hasValue) return answer('text', '验证码已有内容，未覆盖。');
    if (typeof ocr?.recognize !== 'function') return answer('text', '本地识别尚未就绪。');
    const image = frame.locator('#captchaCode + img');
    const before = await image.screenshot({ type: 'png', timeout: 8000 });
    const stable = await frame.evaluate(captchaDomAction, { action: 'inspect' });
    if (JSON.stringify(stable) !== JSON.stringify(snapshot)) return answer('text', '验证码已变化，未填写。');
    const { token: _, generation: __, ...identity } = snapshot;
    challengeKey = digest(JSON.stringify(identity) + ':' + digest(before));
    const result = await ocr.recognize(before, { charset: CHARSET });
    if (!acceptableCaptchaRecognition(result)) return answer('text', '验证码未识别清楚，请在登录窗口填写。', { challengeKey });
    const after = await image.screenshot({ type: 'png', timeout: 8000 });
    if (digest(before) !== digest(after)) return answer('text', '验证码图片已刷新，未填写。', { challengeKey });
    const filled = await frame.evaluate(captchaDomAction, { action: 'fill', expected: snapshot, value: result.text.replace(/\s/g, '') });
    return answer('text', filled ? '已填写验证码，等待登录。' : '登录页或验证码已变化，未填写。', { filled, challengeKey, confidence: result.confidence });
  } catch {
    return answer(snapshot?.kind === 'text' ? 'text' : 'unknown', '验证码读取失败，未填写。', challengeKey ? { challengeKey } : {});
  } finally {
    if (snapshot?.token) await frame.evaluate(captchaDomAction, { action: 'release', token: snapshot.token }).catch(() => {});
  }
}
