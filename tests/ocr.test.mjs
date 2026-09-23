import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOcrEngine, OCR_MAX_IMAGE_BYTES, normalizeOcrCharset } from '../server/ocr.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerPath = path.join(root, 'scripts', 'ocr_worker.py');

async function fixture(t, handler = () => {}, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homework-ocr-test-'));
  await mkdir(path.join(dataDir, 'ocr-venv'));
  await writeFile(path.join(dataDir, 'ocr-venv', 'ocr-ready.json'), JSON.stringify({ available: true, engine: 'ddddocr', version: '1.5.6', provider: 'CPUExecutionProvider' }));
  const children = [];
  const engine = new LocalOcrEngine({ dataDir, pythonPath: process.execPath, workerPath, ...options, spawnProcess(executable, args, spawnOptions) {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['-u', workerPath]);
    assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 1; queueMicrotask(() => child.emit('exit', 1)); };
    child.stdin = new Writable({ write(chunk, encoding, callback) { handler(JSON.parse(chunk.toString()), child, children.length); callback(); } });
    child.stdin.on('finish', () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); });
    return child;
  } });
  t.after(async () => {
    await engine.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { engine, children, dataDir };
}

function answer(child, id, extra = {}) {
  child.stdout.write(JSON.stringify({ id, text: 'Ab23', confidence: 0.9, minConfidence: 0.8, ...extra }) + '\n');
}

test('OCR capability detection is fast, local and does not spawn a model', async t => {
  const { engine, children, dataDir } = await fixture(t);
  assert.equal(engine.isAvailable(), true); assert.equal(children.length, 0);
  await writeFile(path.join(dataDir, 'ocr-venv', 'ocr-ready.json'), '{}');
  assert.equal(engine.isAvailable(), false);
  await assert.rejects(engine.recognize(Buffer.from('image')), /未安装/);
});

test('OCR rejects oversized/empty inputs and non-alphanumeric charsets before spawning', async t => {
  const { engine, children } = await fixture(t);
  for (const value of [Buffer.alloc(0), Buffer.alloc(OCR_MAX_IMAGE_BYTES + 1), 'not a buffer']) await assert.rejects(engine.recognize(value), /Buffer/);
  await assert.rejects(engine.recognize(Buffer.from('x'), { charset: 'abc;' }), /字符范围/);
  assert.equal(normalizeOcrCharset('digits'), '0123456789');
  assert.equal(normalizeOcrCharset('aaB2'), 'aB2'); assert.equal(children.length, 0);
});

test('OCR runs one long-lived hidden process and serializes concurrent images', async t => {
  const received = [];
  const { engine, children } = await fixture(t, (item, child) => { received.push(item); setTimeout(() => answer(child, item.id), 5); });
  const first = engine.recognize(Buffer.from('image1'));
  const second = engine.recognize(Buffer.from('image2'));
  const results = await Promise.all([first, second]);
  assert.equal(children.length, 1); assert.equal(received.length, 2);
  assert.notEqual(received[0].id, received[1].id);
  assert.deepEqual(results[0], { text: 'Ab23', confidence: 0.9, minConfidence: 0.8 });
  assert.equal(Buffer.from(received[0].imageBase64, 'base64').toString(), 'image1');
});

test('OCR rejects queue overload and close settles both active and queued requests', async t => {
  const { engine, children } = await fixture(t, () => {}, { maxQueue: 2 });
  const first = assert.rejects(engine.recognize(Buffer.from('first')), /关闭/);
  const second = assert.rejects(engine.recognize(Buffer.from('second')), /关闭/);
  await assert.rejects(engine.recognize(Buffer.from('third')), /队列已满/);
  await engine.close(); await engine.close(); await Promise.all([first, second]);
  assert.equal(children.length, 1); assert.equal(engine.isAvailable(), false);
  await assert.rejects(engine.recognize(Buffer.from('again')), /关闭/);
});

test('OCR timeout kills stuck worker and the next request can start a fresh one', async t => {
  const { engine, children } = await fixture(t, (item, child, count) => { if (count > 1) queueMicrotask(() => answer(child, item.id)); }, { timeoutMs: 35 });
  await assert.rejects(engine.recognize(Buffer.from('first')), /超时/);
  assert.equal(children[0].killed, true);
  assert.equal((await engine.recognize(Buffer.from('second'))).text, 'Ab23');
  assert.equal(children.length, 2);
});

test('OCR worker errors are redacted and do not poison the next queued request', async t => {
  let count = 0;
  const { engine } = await fixture(t, (item, child) => queueMicrotask(() => {
    if (++count === 1) child.stdout.write(JSON.stringify({ id: item.id, error: 'sensitive image or exception' }) + '\n');
    else answer(child, item.id);
  }));
  await assert.rejects(engine.recognize(Buffer.from('bad')), error => !error.message.includes('sensitive') && /无法识别/.test(error.message));
  assert.equal((await engine.recognize(Buffer.from('good'))).text, 'Ab23');
});

test('OCR validates response correlation, confidence and character range', async t => {
  for (const extra of [{ id: 'wrong' }, { confidence: 8 }, { minConfidence: 0.95 }, { text: 'secret?' }]) {
    const { engine, children } = await fixture(t, (item, child) => queueMicrotask(() => answer(child, item.id, extra)));
    await assert.rejects(engine.recognize(Buffer.from('image')), /不匹配|不符合/);
    assert.equal(children[0].killed, true);
  }
});

test('OCR bounds stdout and unexpected process exit never leaves a pending request', async t => {
  for (const handler of [(_, child) => queueMicrotask(() => child.stdout.write('x'.repeat(32769))), (_, child) => queueMicrotask(() => child.emit('exit', 1))]) {
    const { engine } = await fixture(t, handler);
    await assert.rejects(engine.recognize(Buffer.from('image')), /超出限制|意外退出/);
  }
});

test('Python CTC decoding preserves repeats separated by blank and does not inflate restricted probabilities', t => {
  const python = path.join(root, 'data', 'ocr-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) { t.skip('local OCR venv is optional on other development machines'); return; }
  const script = `import importlib.util,sys,json\nspec=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=m.decode_ctc({'charsets':['A','','B'],'probability':[[.7,.2,.01],[.8,.1,.01],[.1,.8,.01],[.6,.1,.02],[.02,.03,.5]]})\nassert r['text']=='AAB',r\nassert abs(r['minConfidence']-.5)<1e-8,r\nassert .5<r['confidence']<.8,r\nassert m.decode_ctc({'charsets':['A',''],'probability':[[.1,.8]]})['text']==''\nprint(json.dumps(r))\n`;
  const result = spawnSync(python, ['-B', '-c', script, workerPath], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).text, 'AAB');
});

test('setup OCR script parses under Windows PowerShell 5', t => {
  if (process.platform !== 'win32') { t.skip(); return; }
  const script = path.join(root, 'scripts', 'setup-ocr.ps1').replaceAll("'", "''");
  const command = `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 1}`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0);
});
