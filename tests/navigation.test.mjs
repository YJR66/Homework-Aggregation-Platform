import test from 'node:test';
import assert from 'node:assert/strict';
import { gotoReadOnly, isTransientNavigationError, syncFailureMessage } from '../server/navigation.mjs';

test('read-only navigation recovers from network changes with bounded backoff', async () => {
  let calls = 0; const pauses = []; const options = { waitUntil: 'domcontentloaded', timeout: 30000 };
  const response = { status: () => 200 };
  const page = { goto: async (url, received) => {
    assert.equal(url, 'https://i.chaoxing.com/'); assert.equal(received, options);
    if (++calls < 3) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
    return response;
  } };
  assert.equal(await gotoReadOnly(page, 'https://i.chaoxing.com/', options, { sleep: async ms => pauses.push(ms) }), response);
  assert.equal(calls, 3); assert.deepEqual(pauses, [1000, 2000]);
});

test('persistent temporary failures are limited to three GET attempts', async () => {
  let calls = 0;
  const page = { goto: async () => { calls++; throw new Error('net::ERR_INTERNET_DISCONNECTED'); } };
  await assert.rejects(gotoReadOnly(page, 'https://www.yuketang.cn/', {}, { maxAttempts: 99, sleep: async () => {} }), /ERR_INTERNET_DISCONNECTED/);
  assert.equal(calls, 3);
});

test('certificate errors, unknown errors and closed pages are not retried', async () => {
  for (const [message, closed] of [['net::ERR_CERT_AUTHORITY_INVALID', false], ['unknown failure', false], ['net::ERR_NETWORK_CHANGED', true]]) {
    let calls = 0;
    await assert.rejects(gotoReadOnly({ goto: async () => { calls++; throw new Error(message); }, isClosed: () => closed }, 'https://example.test/', {}, { sleep: async () => {} }));
    assert.equal(calls, 1);
  }
});

test('temporary gateway errors and navigation timeouts can recover, login responses are not retried', async () => {
  let calls = 0;
  const timeout = Object.assign(new Error('slow response'), { name: 'TimeoutError' });
  const page = { goto: async () => { calls++; if (calls === 1) throw timeout; return { status: () => calls === 2 ? 503 : 200 }; } };
  assert.equal((await gotoReadOnly(page, 'https://example.test/', {}, { sleep: async () => {} })).status(), 200);
  assert.equal(calls, 3);
  calls = 0;
  await gotoReadOnly({ goto: async () => { calls++; return { status: () => 401 }; } }, 'https://example.test/');
  assert.equal(calls, 1);
});

test('network diagnostics never expose signed navigation URLs or ANSI logs', () => {
  const error = new Error('page.goto: net::ERR_NETWORK_CHANGED at https://example.test/?token=private\nCall log:\n\u001b[2m private');
  assert.equal(isTransientNavigationError(error), true);
  const message = syncFailureMessage(error);
  assert.match(message, /已保留原有清单/);
  assert.doesNotMatch(message, /private|https:|\u001b|Call log/);
});
