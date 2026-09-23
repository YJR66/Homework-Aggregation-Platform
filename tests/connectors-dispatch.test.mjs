import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAssignments, CONNECTOR_CAPABILITIES } from '../server/connectors.mjs';

test('only the four verified collectors are eligible for dispatch', async () => {
  assert.deepEqual(Object.keys(CONNECTOR_CAPABILITIES).sort(), ['chaoxing', 'pta', 'xiji', 'yuketang'].sort());
  for (const id of ['other', '__proto__', 'constructor']) {
    await assert.rejects(collectAssignments({ platform: { id } }), /不支持的平台/);
  }
});
