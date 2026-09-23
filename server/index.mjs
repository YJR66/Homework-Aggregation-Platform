import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { Store, exportIcs } from './store.mjs';
import { Vault } from './vault.mjs';
import { BrowserManager } from './browser.mjs';
import { collectAssignments } from './connectors.mjs';
import { gotoReadOnly, syncFailureMessage } from './navigation.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(ROOT, 'public');

export function validateEntryUrl(id, value) {
  const u = new URL(value);
  const domains = { chaoxing: ['chaoxing.com'], yuketang: ['yuketang.cn'], pta: ['pintia.cn'], xiji: ['vpn.neuq.edu.cn'] }[id] || [];
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !domains.some(d => u.hostname === d || (id !== 'xiji' && u.hostname.endsWith(`.${d}`)))) throw new Error('入口必须是该平台可信域名下的 HTTPS 地址。');
  return u.href;
}

export async function createApplication({ dataDir = path.join(ROOT, 'data'), browserFactory, collector = collectAssignments, vault: suppliedVault } = {}) {
  await mkdir(dataDir, { recursive: true });
  const store = await new Store(dataDir).init();
  const vault = suppliedVault || await new Vault(dataDir).init();
  // A full refresh uses one isolated browser profile/context per platform and
  // can therefore run the platform workers concurrently. Keep the legacy
  // `platformId` field for single-platform callers and expose all active
  // workers separately for the UI/API.
  const sync = { running: false, platformId: null, platformIds: [], startedAt: null };
  const loginJobs = new Set();
  const browserOptions = { dataDir, getCredentials: id => vault.get(id), onStatus: (id, patch) => store.updatePlatform(id, { ...patch,
    ...(patch.message ? { message: vault.redact(patch.message) } : {}),
    ...(patch.authMessage ? { authMessage: vault.redact(patch.authMessage) } : {}),
  }).catch(() => {}) };
  const browser = browserFactory ? browserFactory(browserOptions) : new BrowserManager(browserOptions);
  let closed = false;
  const jobs = new Set();
  function background(promise) { jobs.add(promise); promise.catch(() => {}).finally(() => jobs.delete(promise)); }
  function runAuth(platform, { verifyOnly = false, interactive = false, syncAfter = false } = {}) {
    if (sync.running || loginJobs.size || closed) return false;
    loginJobs.add(platform.id);
    background((async () => {
      let authenticated = false;
      try {
        const result = verifyOnly ? await browser.verifySession(platform) : await browser.authenticate(platform, { interactive });
        authenticated = result.authenticated === true;
        if (!authenticated) await store.updatePlatform(platform.id, {
          status: result.challengeType ? 'awaiting_user' : result.authenticated === false ? 'auth_required' : 'error',
          message: vault.redact(result.reason),
        });
      } catch {
        await store.updatePlatform(platform.id, { loginStatus: 'unknown', authMessage: '登录检查连接失败，请稍后重试。' });
      } finally { loginJobs.delete(platform.id); }
      // Release the authentication lock before acquiring the sync lock.
      if (authenticated && syncAfter && !closed) await runSync(platform.id);
    })());
    return true;
  }
  async function runSync(id, currentPage = false, automatic = false) {
    if (sync.running || loginJobs.size || closed) return false;
    const targets = store.data.platforms.filter(platform => !id || platform.id === id).map(platform => ({ ...platform }));
    if (!targets.length) return false;
    // Claim the global sync lock before starting any asynchronous platform work.
    sync.running = true;
    sync.platformId = targets.length === 1 ? targets[0].id : null;
    sync.platformIds = targets.map(platform => platform.id);
    sync.startedAt = new Date().toISOString();
    const task = (async () => {
      const scanPlatform = async platform => {
        if (closed) return;
        if (automatic && browser.isOpen(platform.id) && ['awaiting_user', 'auth_required'].includes(platform.status)) return;
        await store.updatePlatform(platform.id, { status: 'syncing', message: '正在读取作业…', lastAttemptAt: new Date().toISOString() });
        try {
          const { context, page } = await browser.getSession(platform);
          const targetUrl = platform.syncUrl || platform.entryUrl;
          if (!currentPage) await gotoReadOnly(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const collect = () => collector({ platform, context, page, knownAssignments: store.data.assignments.filter(item => item.platform === platform.id), onProgress: message => store.updatePlatform(platform.id, { message: vault.redact(message) }).catch(() => {}) });
          let result = await collect();
          const markExpired = () => store.updatePlatform(platform.id, { loginStatus: 'expired', authMessage: '登录已过期。', lastAuthCheckAt: new Date().toISOString() });
          if (result.authenticated === false && platform.loginStatus !== 'invalid_credentials') await markExpired();
          if (result.authenticated === false && vault.configured(platform.id) && browser.authenticate
            && platform.loginStatus !== 'invalid_credentials') {
            const auth = await browser.authenticate(platform, { navigate: true });
            if (auth.authenticated === true) {
              await gotoReadOnly(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
              result = await collect();
              if (result.authenticated === false) await markExpired();
            } else result = { ...result, message: auth.reason };
          }
          const items = Array.isArray(result.assignments) ? result.assignments : [];
          // Only a confirmed complete, authenticated scan may mark older rows
          // as missing; partial scans still retain every previously seen task.
          if (items.length || result.complete && result.authenticated) await store.merge(platform.id, items, { complete: result.complete && result.authenticated });
          await store.updatePlatform(platform.id, {
            status: result.authenticated === false ? 'auth_required' : result.authenticated !== true ? 'error' : result.complete ? 'connected' : 'partial',
            message: vault.redact(result.message || (result.complete ? `已读取 ${items.length} 项作业。` : '作业未读全，请到平台检查。')),
            ...(result.authenticated === true && result.complete ? { lastSyncAt: new Date().toISOString() } : {}),
            ...(result.authenticated === true ? { loginStatus: 'authenticated', authMessage: '已登录。', lastAuthCheckAt: new Date().toISOString() } : {}),
          });
        } catch (error) {
          await store.updatePlatform(platform.id, { status: 'error', message: vault.redact(syncFailureMessage(error)) });
        }
      };
      try {
        // Each platform owns an independent browser context/profile. allSettled
        // ensures a failed connector never cancels the other platform scans.
        await Promise.allSettled(targets.map(scanPlatform));
      } finally {
        sync.running = false; sync.platformId = null; sync.platformIds = [];
      }
    })();
    background(task); return true;
  }
  let nextAutoAt = Date.now() + store.data.settings.syncIntervalMinutes * 60000;
  const interval = setInterval(() => {
    if (store.data.settings.autoSync && Date.now() >= nextAutoAt && !sync.running && !loginJobs.size) {
      nextAutoAt = Date.now() + store.data.settings.syncIntervalMinutes * 60000;
      runSync(undefined, false, true);
    }
  }, 15000);
  interval.unref();

  async function closeApplication() {
    if (closed) return;
    closed = true; clearInterval(interval);
    await browser.close();
    await Promise.allSettled([...jobs]);
    await store.queue.catch(() => {});
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, body) => { if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, { error: '仅允许本机访问。' });
      if (req.headers.origin && ![`http://${host}`, `http://127.0.0.1:${server.address()?.port}`, `http://localhost:${server.address()?.port}`].includes(req.headers.origin)) return send(403, { error: '来源校验失败。' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '禁止跨站请求。' });
      const url = new URL(req.url, `http://${host}`);
      const pathname = url.pathname;
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: '请求需要 application/json。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32768) return send(413, { error: '请求过大。' }); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
        catch { return send(400, { error: 'JSON 格式错误。' }); }
      }
      if (req.method === 'GET' && pathname === '/api/state') return send(200, {
        ...store.data, platforms: store.data.platforms.map(p => ({ ...p, configured: vault.configured(p.id), authOpen: browser.isOpen(p.id) })),
        sync: { ...sync, loginPlatforms: [...loginJobs] }, capabilities: { browserAvailable: browser.browserAvailable, ocrAvailable: browser.ocrAvailable === true },
      });
      if (req.method === 'GET' && pathname === '/api/export.ics') {
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="homework.ics"', 'Cache-Control': 'no-store' });
        return res.end(exportIcs(store.data.assignments));
      }
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        send(202, { ok: true });
        setTimeout(() => closeApplication().catch(() => {}), 100);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/sync') {
        if (body.platform && !store.platform(body.platform)) return send(400, { error: '未知平台。' });
        return await runSync(body.platform) ? send(202, { ok: true }) : send(409, { error: '正在同步或登录，请稍候。' });
      }
      const platformRoute = pathname.match(/^\/api\/platforms\/(\w+)\/(login|collect|credentials|authenticate|verify)$/);
      if (platformRoute && req.method === 'POST') {
        const [, id, action] = platformRoute; const platform = store.platform(id);
        if (!platform) return send(404, { error: '未知平台。' });
        if (sync.running || loginJobs.size) return send(409, { error: '正在同步或登录，请稍候。' });
        if (action === 'collect') return await runSync(id, true) ? send(202, { ok: true }) : send(409, { error: '正在同步。' });
        if (action === 'authenticate' || action === 'verify' || action === 'login' && browser.authenticate) {
          return runAuth(platform, { verifyOnly: action === 'verify', interactive: action === 'login', syncAfter: action !== 'verify' })
            ? send(202, { ok: true }) : send(409, { error: '正在同步或登录，请稍候。' });
        }
        if (action === 'login') {
          loginJobs.add(id);
          background((async () => {
            try { await browser.openLogin(platform); }
            catch (error) { await store.updatePlatform(id, { status: 'error', message: vault.redact(error.message) }); }
            finally { loginJobs.delete(id); }
          })());
          return send(202, { ok: true });
        }
        const credentials = {};
        for (const field of ['username', 'password', 'vpnUsername', 'vpnPassword']) {
          if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 500)) return send(400, { error: '账号或密码格式不正确。' });
          if (body[field]) credentials[field] = field.endsWith('Username') || field === 'username' ? body[field].trim() : body[field];
        }
        const entryUrl = body.entryUrl ? validateEntryUrl(id, body.entryUrl) : platform.entryUrl;
        // This endpoint is the explicit credential-login path. A previous
        // encrypted password must not silently satisfy an empty login form.
        if (!credentials.username || !credentials.password) return send(400, { error: '请填写账号和密码。' });
        if (id === 'xiji' && (!credentials.vpnUsername || !credentials.vpnPassword)) return send(400, { error: '请填写学校统一身份认证账号和密码。' });
        const oldUsername = vault.get(id)?.username;
        if (oldUsername && oldUsername !== credentials.username) return send(409, { error: '该工作区已绑定其他账号。请使用独立工作区，避免混入旧账号的作业和登录态。' });
        loginJobs.add(id);
        try {
          await vault.set(id, credentials);
          browser.resetLoginAttempts?.(id);
          await store.updatePlatform(id, { entryUrl, status: 'auth_required', loginStatus: 'expired', message: '账号已加密保存，正在登录。' });
        } finally { loginJobs.delete(id); }
        if (browser.authenticate) runAuth(store.platform(id), { syncAfter: true });
        return send(200, { ok: true });
      }
      const assignmentRoute = pathname.match(/^\/api\/assignments\/([a-f0-9]+)$/);
      if (req.method === 'PATCH' && assignmentRoute) {
        if (typeof body.completed !== 'boolean') return send(400, { error: 'completed 必须为布尔值。' });
        const assignment = store.data.assignments.find(item => item.id === assignmentRoute[1]);
        if (!assignment) return send(404, { error: '作业不存在。' });
        if (body.completed && !['submitted', 'completed'].includes(assignment.status)) {
          return send(409, { error: '不能直接标记完成。请先向平台同步并取得已提交或已完成的云端状态。' });
        }
        return await store.complete(assignmentRoute[1], body.completed) ? send(200, { ok: true }) : send(404, { error: '作业不存在。' });
      }
      if (req.method === 'PUT' && pathname === '/api/settings') {
        if (typeof body.autoSync !== 'boolean' || !Number.isInteger(body.syncIntervalMinutes) || body.syncIntervalMinutes < 5 || body.syncIntervalMinutes > 1440) return send(400, { error: '同步间隔须为 5～1440 分钟整数。' });
        await store.updateSettings({ autoSync: body.autoSync, syncIntervalMinutes: body.syncIntervalMinutes });
        nextAutoAt = Date.now() + body.syncIntervalMinutes * 60000;
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/styles.css'].includes(pathname)) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(content);
      }
      send(404, { error: '未找到资源。' });
    } catch (error) { send(400, { error: vault.redact(error.message || '请求处理失败。') }); }
  });
  return { server, store, vault, browser, runSync, runAuth, close: closeApplication };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createApplication();
    const port = Number(process.env.PORT || 4317);
    app.server.listen(port, '127.0.0.1', () => console.log(`作业聚合系统：http://127.0.0.1:${port}`));
    app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请打开已有服务或设置 PORT。` : '本地服务启动失败。'); process.exit(1); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().finally(() => process.exit(0)));
  } catch (error) { console.error(`启动失败：${error.message}`); process.exit(1); }
}
