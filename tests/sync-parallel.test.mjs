import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication } from '../server/index.mjs';

const PLATFORMS = ['chaoxing', 'yuketang', 'pta', 'xiji'];

function mockBrowser() {
  return {
    browserAvailable: true,
    isOpen: () => false,
    getSession: async () => ({ page: { goto: async () => {} }, context: {} }),
    close: async () => {},
  };
}

async function withApp(collector, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-sync-parallel-'));
  const vault = { get: () => ({}), configured: () => false, redact: value => String(value) };
  const app = await createApplication({ dataDir: dir, vault, browserFactory: mockBrowser, collector });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const waitForIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await (await fetch(`${base}/api/state`)).json();
      if (!state.sync.running) return state;
      await delay(5);
    }
    assert.fail('同步任务未在预期时间内结束');
  };
  try { return await fn({ app, base, waitForIdle }); }
  finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}

test('全平台同步并行启动四个平台且保留全局同步锁', async () => {
  const started = [];
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withApp(async ({ platform }) => {
    started.push(platform.id);
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return {
      authenticated: true,
      complete: true,
      assignments: [{ externalId: `parallel-${platform.id}`, title: `${platform.name}并行测试`, course: '测试课程', status: 'submitted' }],
    };
  }, async ({ app, waitForIdle }) => {
    assert.equal(await app.runSync(undefined, true), true);
    // runSync must claim the lock before any asynchronous collector starts.
    assert.equal(await app.runSync('pta', true), false);
    try {
      for (let attempt = 0; attempt < 100 && started.length < PLATFORMS.length; attempt++) await delay(5);
      assert.deepEqual(new Set(started), new Set(PLATFORMS));
      assert.equal(maxActive, PLATFORMS.length, '四个平台应同时处于读取中');
    } finally {
      // Also release a partially started sequential implementation so a failed
      // assertion cannot leave the application waiting on a blocked collector.
      release();
    }
    const state = await waitForIdle();
    assert.deepEqual(state.assignments.map(item => item.platform).sort(), [...PLATFORMS].sort());
    assert.ok(state.platforms.every(platform => platform.status === 'connected'));
  });
});
test('指定单个平台同步不会意外触发其它平台 collector', async () => {
  const calls = [];
  await withApp(async ({ platform }) => {
    calls.push(platform.id);
    await delay(5);
    return { authenticated: true, complete: true, assignments: [] };
  }, async ({ app, waitForIdle }) => {
    assert.equal(await app.runSync('pta', true), true);
    await waitForIdle();
    assert.deepEqual(calls, ['pta']);
  });
});

test('单个平台 collector 失败不会取消其它并行扫描', async () => {
  await withApp(async ({ platform }) => {
    await delay(5);
    if (platform.id === 'pta') throw new Error('测试平台读取失败');
    return {
      authenticated: true,
      complete: true,
      assignments: [{ externalId: `healthy-${platform.id}`, title: `${platform.name}保留结果`, course: '测试课程', status: 'submitted' }],
    };
  }, async ({ app, waitForIdle }) => {
    assert.equal(await app.runSync(undefined, true), true);
    const state = await waitForIdle();
    assert.equal(state.platforms.find(platform => platform.id === 'pta').status, 'error');
    for (const id of PLATFORMS.filter(id => id !== 'pta')) {
      assert.equal(state.platforms.find(platform => platform.id === id).status, 'connected');
    }
    assert.deepEqual(state.assignments.map(item => item.platform).sort(), PLATFORMS.filter(id => id !== 'pta').sort());
  });
});
