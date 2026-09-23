import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptableCaptchaRecognition, solveTextCaptcha, trustedXijiCaptcha } from '../server/captcha.mjs';

const root = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const base = () => ({ kind: 'text', url: root + 'indexcs/simple.jsp?loginErr=0', token: 'document-entry-1', generation: 0,
  input: { id: 'captchaCode', name: 'captchaCode', type: 'text', disabled: false, readOnly: false, hasValue: false },
  form: { id: '', name: '', rawAction: '/login/loginproc.jsp', action: 'https://ccelab.neuq.edu.cn/login/loginproc.jsp' },
  image: { rawSrc: '/cgjiaoyan', src: 'https://ccelab.neuq.edu.cn/cgjiaoyan', currentSrc: root + 'cgjiaoyan', width: 190, height: 65, complete: true } });
const good = { text: 'aB3D5', confidence: 0.94, minConfidence: 0.81 };

function fixture({ snapshot = base(), second = snapshot, images = [Buffer.from('captcha-pixels'), Buffer.from('captcha-pixels')], fill = true, url = snapshot.url } = {}) {
  const calls = [], shots = []; let inspections = 0;
  const frame = { url: () => url, locator(selector) { assert.equal(selector, '#captchaCode + img'); return { screenshot: async options => {
    assert.equal(Object.hasOwn(options, 'path'), false, 'captcha image must remain in memory');
    shots.push(options); return images[Math.min(shots.length - 1, images.length - 1)];
  } }; }, async evaluate(fn, args) {
    calls.push(args);
    if (args.action === 'inspect') return structuredClone(inspections++ === 0 ? snapshot : second);
    if (args.action === 'fill') return fill;
    return true;
  } };
  return { frame, calls, shots };
}

test('本地验证码只接受4-6位ASCII字母数字和双置信度阈值', () => {
  assert.equal(acceptableCaptchaRecognition(good), true);
  assert.equal(acceptableCaptchaRecognition({ ...good, text: ' a B3D5\n' }), true);
  for (const value of [{ ...good, text: 'ab@12' }, { ...good, text: 'ＡB3D5' }, { ...good, text: 'abc123' }, { ...good, confidence: 0.79 }, { ...good, minConfidence: 0.64 }, { ...good, confidence: 94 }, { ...good, minConfidence: NaN }]) assert.equal(acceptableCaptchaRecognition(value), false);
  assert.equal(acceptableCaptchaRecognition({ ...good, text: '1234' }, { length: 4 }), true);
  assert.equal(acceptableCaptchaRecognition({ ...good, text: '123456' }, { length: 6 }), true);
});

test('希冀验证码必须是已观察的登录页、表单和同站图片', () => {
  assert.equal(trustedXijiCaptcha(base()), true);
  const scenarios = [
    value => value.url = root + 'assignment/index.jsp?assignID=915',
    value => value.url = 'https://vpn.neuq.edu.cn.evil.example/' + 'indexcs/simple.jsp',
    value => value.form.action = 'https://evil.example/login/loginproc.jsp',
    value => value.form.rawAction = '/assignment/stuAnswerHandler.jsp',
    value => value.image.currentSrc = 'https://evil.example/cgjiaoyan',
    value => value.image.src = 'data:image/png;base64,abc',
    value => value.image.rawSrc = 'https://ccelab.neuq.edu.cn.evil.example/cgjiaoyan',
    value => value.image.complete = false,
    value => value.input.readOnly = true,
    value => value.input.type = 'password',
  ];
  for (const mutate of scenarios) { const value = base(); mutate(value); assert.equal(trustedXijiCaptcha(value), false); }
});

test('识别只在内存截图并填写，不返回识别文字、不调用提交', async () => {
  const f = fixture(); let count = 0;
  const result = await solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform', ocr: { recognize: async (buffer, options) => {
    count++; assert.ok(Buffer.isBuffer(buffer)); assert.match(options.charset, /0123456789/); return good;
  } } });
  assert.equal(result.filled, true); assert.equal(result.type, 'text'); assert.equal(count, 1);
  assert.match(result.challengeKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(good.text), false);
  assert.deepEqual(f.calls.map(call => call.action), ['inspect', 'inspect', 'fill', 'release']);
  assert.equal(f.calls.find(call => call.action === 'fill').value, good.text);
  assert.equal(f.shots.length, 2);
});

test('同一挑战签名不随临时观察token变化而变化', async () => {
  const first = fixture(), snapshot = base(); snapshot.token = 'another-entry'; snapshot.generation = 6;
  const second = fixture({ snapshot });
  const run = f => solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => good } });
  assert.equal((await run(first)).challengeKey, (await run(second)).challengeKey);
});

test('OCR低置信度或错误长度不填且保留挑战签名供登录预算去重', async () => {
  for (const result of [{ ...good, confidence: 0.7 }, { ...good, text: 'AB12' }]) {
    const f = fixture(); const output = await solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => result } });
    assert.equal(output.filled, false); assert.match(output.challengeKey, /^[a-f0-9]{64}$/);
    assert.equal(f.calls.some(call => call.action === 'fill'), false);
  }
});

test('截图期间页面、表单或图像代次变化立即停止', async () => {
  for (const change of [s => s.url += '&changed=1', s => s.form.action = 'https://evil.example/', s => s.generation++]) {
    const second = base(); change(second); const f = fixture({ second });
    const result = await solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => assert.fail('must not OCR changed document') } });
    assert.equal(result.filled, false); assert.equal(f.calls.some(call => call.action === 'fill'), false);
  }
});

test('OCR期间图片像素变化或最终原子校验失败不填写', async () => {
  const changed = fixture({ images: [Buffer.from('old'), Buffer.from('new')] });
  const result = await solveTextCaptcha({ ...changed, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => good } });
  assert.equal(result.filled, false); assert.equal(changed.calls.some(call => call.action === 'fill'), false);
  const race = fixture({ fill: false });
  assert.equal((await solveTextCaptcha({ ...race, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => good } })).filled, false);
});

test('短信、滑块、点选明确降级，不调用文字OCR', async () => {
  for (const kind of ['sms', 'slider', 'click', 'unknown']) {
    const f = fixture({ snapshot: { kind }, url: root + 'indexcs/simple.jsp' });
    const result = await solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => assert.fail('unsupported challenge') } });
    assert.equal(result.type, kind); assert.equal(result.filled, false); assert.equal(f.shots.length, 0);
  }
});

test('输入框已有内容、OCR未就绪、异常均不覆盖且不泄露错误', async () => {
  const snapshot = base(); snapshot.input.hasValue = true;
  const existing = fixture({ snapshot });
  assert.equal((await solveTextCaptcha({ ...existing, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => assert.fail() } })).filled, false);
  assert.equal(existing.shots.length, 0);
  const absent = fixture();
  assert.equal((await solveTextCaptcha({ ...absent, platformId: 'xiji', stage: 'platform' })).filled, false);
  const failure = fixture();
  const result = await solveTextCaptcha({ ...failure, platformId: 'xiji', stage: 'platform', ocr: { recognize: async () => { throw new Error('secret-ocr-answer'); } } });
  assert.equal(result.filled, false); assert.equal(JSON.stringify(result).includes('secret-ocr-answer'), false);
  assert.equal(failure.calls.at(-1).action, 'release');
});

test('不可信或其他平台不操作希冀图形验证码', async () => {
  const f = fixture({ url: 'https://evil.example/' });
  assert.equal((await solveTextCaptcha({ ...f, platformId: 'xiji', stage: 'platform' })).handled, false);
  assert.equal(f.calls.length, 0);
  const other = fixture({ url: 'https://www.yuketang.cn/web' });
  assert.equal((await solveTextCaptcha({ ...other, platformId: 'yuketang', stage: 'platform' })).filled, false);
  assert.equal(other.shots.length, 0);
});
