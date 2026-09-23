import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication } from '../server/index.mjs';

test('unknown loading failures preserve tasks and last successful sync, and remain eligible for automatic recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-sync-resilience-'));
  let result = { assignments: [], authenticated: null, complete: false, message: '课程目录暂未加载' };
  let calls = 0;
  const vault = { get: () => ({}), configured: () => true, redact: value => value };
  const app = await createApplication({ dataDir: dir, vault,
    browserFactory: () => ({ browserAvailable: true, isOpen: () => true, getSession: async () => ({ page: { goto: async () => {} }, context: {} }), close: async () => {} }),
    collector: async () => { calls++; return result; },
  });
  const lastSuccess = '2026-09-22T00:00:00.000Z';
  const item = { externalId: 'stable-task', title: '已读取的作业', course: '课程', status: 'pending' };
  try {
    await app.store.merge('yuketang', [item], { complete: true });
    await app.store.updatePlatform('yuketang', { status: 'connected', lastSyncAt: lastSuccess });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const run = async (automatic = false) => {
      assert.equal(await app.runSync('yuketang', false, automatic), true);
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await (await fetch(`${base}/api/state`)).json();
        if (!state.sync.running) return state;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('sync did not finish');
    };
    let state = await run();
    let platform = state.platforms.find(p => p.id === 'yuketang');
    assert.equal(platform.status, 'error');
    assert.equal(platform.lastSyncAt, lastSuccess);
    assert.equal(state.assignments.length, 1);
    assert.equal(state.assignments[0].sourceMissing, false);

    result = { assignments: [], authenticated: true, complete: false, message: '本次只读取部分课程' };
    state = await run(true);
    platform = state.platforms.find(p => p.id === 'yuketang');
    assert.equal(platform.status, 'partial');
    assert.equal(platform.lastSyncAt, lastSuccess);

    result = { assignments: [item], authenticated: true, complete: true };
    state = await run(true);
    assert.equal(calls, 3, 'unknown failures must not block later automatic sync even with a visible browser');
    platform = state.platforms.find(p => p.id === 'yuketang');
    assert.equal(platform.status, 'connected');
    assert.notEqual(platform.lastSyncAt, lastSuccess);
    assert.equal(state.assignments.length, 1);

    result = { assignments: [], authenticated: false, complete: false, message: '明确登录页' };
    state = await run();
    assert.equal(state.platforms.find(p => p.id === 'yuketang').status, 'auth_required');
    state = await run(true);
    assert.equal(calls, 4, 'a real interactive login challenge remains untouched by automatic sync');
    assert.equal(state.assignments[0].sourceMissing, false);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
