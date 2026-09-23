import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const OCR_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normalizeOcrCharset(value = 'alnum') {
  if (value === 'alnum') return ALNUM;
  if (value === 'digits') return '0123456789';
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(value)) throw new Error('OCR 字符范围仅支持英文字母和数字。');
  return [...new Set(value)].join('');
}

/** Local JSONL child process; no shell, network, image files, or credential logging. */
export class LocalOcrEngine {
  constructor({ dataDir = path.join(ROOT, 'data'), timeoutMs = 20000, maxQueue = 8,
    pythonPath, workerPath = path.join(ROOT, 'scripts', 'ocr_worker.py'), spawnProcess = spawn } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.pythonPath = pythonPath || path.join(this.dataDir, 'ocr-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.workerPath = path.resolve(workerPath);
    this.timeoutMs = Math.min(20000, Math.max(25, Number(timeoutMs) || 20000));
    this.maxQueue = Math.min(16, Math.max(1, Number(maxQueue) || 8));
    this.spawnProcess = spawnProcess;
    this.queue = []; this.active = null; this.child = null; this.closed = false; this.closePromise = null;
  }

  isAvailable() {
    if (this.closed || !existsSync(this.pythonPath) || !existsSync(this.workerPath)) return false;
    try {
      const ready = JSON.parse(readFileSync(path.join(this.dataDir, 'ocr-venv', 'ocr-ready.json'), 'utf8'));
      return ready.available === true && ready.engine === 'ddddocr' && ready.version === '1.5.6' && ready.provider === 'CPUExecutionProvider';
    } catch { return false; }
  }

  recognize(image, options = {}) {
    if (this.closed) return Promise.reject(new Error('本地 OCR 已关闭。'));
    if (!Buffer.isBuffer(image) || image.length < 1 || image.length > OCR_MAX_IMAGE_BYTES) return Promise.reject(new Error('OCR 图片必须是非空 Buffer，且不超过 2 MB。'));
    let charset;
    try { charset = normalizeOcrCharset(options.charset); } catch (error) { return Promise.reject(error); }
    if (!this.isAvailable()) return Promise.reject(new Error('本地 OCR 未安装或自检未通过，请运行 scripts/setup-ocr.ps1。'));
    if (this.queue.length + Number(Boolean(this.active)) >= this.maxQueue) return Promise.reject(new Error('本地 OCR 队列已满，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const item = { id: randomUUID(), imageBase64: image.toString('base64'), charset, resolve, reject, timer: null };
      // A queued image also expires within 20 seconds; callers never wait forever.
      item.timer = setTimeout(() => {
        if (this.active === item) this.#failWorker(new Error('本地 OCR 识别超时。'));
        else {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          item.imageBase64 = ''; reject(new Error('本地 OCR 排队超时。'));
        }
      }, this.timeoutMs);
      this.queue.push(item); this.#pump();
    });
  }

  #startWorker() {
    if (this.child) return this.child;
    const child = this.spawnProcess(this.pythonPath, ['-u', this.workerPath], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '2' },
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 32768) { this.#failWorker(new Error('本地 OCR 返回数据超出限制。')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let output;
        try { output = JSON.parse(line); } catch { this.#failWorker(new Error('本地 OCR 通信格式异常。')); return; }
        if (output.ready === true) continue;
        const item = this.active;
        if (!item || output.id !== item.id) { this.#failWorker(new Error('本地 OCR 返回了不匹配的请求。')); return; }
        if (output.error) { this.#finish(item, new Error('本地 OCR 无法识别这张图片。')); continue; }
        if (typeof output.text !== 'string' || output.text.length > 32 || [...output.text].some(char => !item.charset.includes(char))
          || ![output.confidence, output.minConfidence].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
          || output.minConfidence > output.confidence + 1e-6) { this.#failWorker(new Error('本地 OCR 返回结果不符合约定。')); return; }
        this.#finish(item, null, { text: output.text, confidence: output.confidence, minConfidence: output.minConfidence });
      }
    });
    // Libraries may log arbitrary image/exception data; never forward it to the UI.
    child.stderr.resume();
    child.stdin.on('error', () => { if (this.child === child) this.#failWorker(new Error('本地 OCR 输入通道已关闭。')); });
    child.on('error', () => { if (this.child === child) this.#failWorker(new Error('本地 OCR 进程启动失败。')); });
    child.on('exit', () => { if (this.child === child) this.#failWorker(new Error('本地 OCR 进程意外退出。')); });
    return child;
  }

  #pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const item = this.queue.shift(); this.active = item;
    try {
      const child = this.#startWorker();
      child.stdin.write(JSON.stringify({ id: item.id, imageBase64: item.imageBase64, charset: item.charset }) + '\n');
      item.imageBase64 = '';
    } catch { this.#failWorker(new Error('本地 OCR 进程启动失败。')); }
  }

  #finish(item, error, result) {
    if (this.active !== item) return;
    clearTimeout(item.timer); item.imageBase64 = ''; this.active = null;
    if (error) item.reject(error); else item.resolve(result);
    queueMicrotask(() => this.#pump());
  }

  #failWorker(error) {
    const child = this.child; this.child = null;
    if (child) { child.stdin.destroy(); try { child.kill(); } catch {} }
    if (this.active) this.#finish(this.active, error);
    else queueMicrotask(() => this.#pump());
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const item of this.queue.splice(0)) { clearTimeout(item.timer); item.imageBase64 = ''; item.reject(new Error('本地 OCR 已关闭。')); }
    if (this.active) this.#finish(this.active, new Error('本地 OCR 已关闭。'));
    const child = this.child; this.child = null;
    this.closePromise = child ? new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, 1500);
      child.once('exit', finish); child.once('error', finish);
      child.stdin.end();
      // EOF lets the JSONL worker stop naturally after its current inference.
      if (child.exitCode !== null && child.exitCode !== undefined) finish();
    }) : Promise.resolve();
    return this.closePromise;
  }
}

// Name retained for callers that prefer the explicit Node-side engine name.
export const NodeLocalOcrEngine = LocalOcrEngine;
