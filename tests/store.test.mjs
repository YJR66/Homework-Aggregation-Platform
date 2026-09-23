import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, safeUrl, exportIcs, assignmentId, safeProgress } from '../server/store.mjs';

test('同步幂等、保留勾选和历史记录、拒绝危险链接', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-store-'));
  try {
    const s = await new Store(dir).init();
    const item = { externalId:'42', title:'测试作业', course:'高等数学', dueAt:'2026-09-23T12:00:00+08:00', status:'submitted', url:'https://i.chaoxing.com/work?id=42' };
    await s.merge('chaoxing', [item,item]);
    assert.equal(s.data.assignments.length,1);
    await s.complete(s.data.assignments[0].id,true);
    await s.merge('chaoxing',[{...item,title:'修订标题',dueAt:null,url:'javascript:alert(1)'}]);
    assert.equal(s.data.assignments.length,1);
    assert.equal(s.data.assignments[0].completed,true);
    assert.equal(s.data.assignments[0].url,'');
    await s.merge('chaoxing',[]);
    assert.equal(s.data.assignments.length,1);
    const recovered=await new Store(dir).init();
    assert.equal(recovered.data.assignments[0].title,'修订标题');
    JSON.parse(await readFile(s.filename,'utf8'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('作业 ID 按平台隔离', () => {
  assert.notEqual(assignmentId('pta',{externalId:'1'}),assignmentId('xiji',{externalId:'1'}));
  assert.equal(safeUrl('data:text/html,x'),'');
  assert.equal(safeUrl('https://user:pass@example.com'),'');
});
test('只在完整扫描后标注消失记录，绝不等同提交或删除',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'homework-history-'));
  try {
    const s=await new Store(dir).init(); const item={externalId:'1',title:'会变化的作业',status:'pending'};
    await s.merge('pta',[item],{complete:true});
    await s.merge('pta',[],{complete:false});
    assert.equal(s.data.assignments[0].sourceMissing,false);
    await s.merge('pta',[],{complete:true});
    assert.equal(s.data.assignments.length,1);
    assert.equal(s.data.assignments[0].sourceMissing,true);
    assert.equal(s.data.assignments[0].status,'pending');
    assert.equal(s.data.assignments[0].completed,false);
    await s.merge('pta',[item],{complete:true});
    assert.equal(s.data.assignments[0].sourceMissing,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('ICS 导出只包含有截止日期的待办并正确转义和折行',()=>{
  const base={id:'1',title:'线性代数'.repeat(40)+';一,二\n三',course:'数学',platform:'pta',dueAt:'2026-09-23T12:00:00+08:00',url:'https://pintia.cn',status:'pending'};
  const ics=exportIcs([base,{...base,id:'2',completed:true},{...base,id:'3',status:'submitted'},{...base,id:'4',dueAt:null},{...base,id:'5',status:'completed'}]);
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);
  assert.match(ics,/DTSTART:20260923T040000Z/);
  assert.ok(ics.split('\r\n').every(line=>Buffer.byteLength(line)<=75));
  assert.ok(ics.includes('\\;一\\,二\\n三'));
});

test('verified detail state, evidence and zero progress survive persistence without overriding local completion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homework-detail-store-'));
  try {
    const s = await new Store(dir).init();
    const item = { externalId: 'read:1', title: '课件', status: 'completed', kind: 'material', statusLabel: '阅读中 1/2 页', statusEvidence: '平台个人记录 1/2 页', detailComplete: false, progress: { completed: 1, total: 2, unit: '页' } };
    await s.merge('yuketang', [item]);
    await s.complete(s.data.assignments[0].id, true);
    await s.merge('yuketang', [{ ...item, status: 'completed', progress: { completed: 2, total: 2, unit: '页' } }]);
    const persisted = (await new Store(dir).init()).data.assignments[0];
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.completed, true);
    assert.equal(persisted.externalId, item.externalId);
    assert.equal(persisted.kind, 'material');
    assert.equal(persisted.statusEvidence, item.statusEvidence);
    assert.equal(persisted.detailComplete, false);
    assert.deepEqual(persisted.progress, { completed: 2, total: 2, unit: '页' });
    assert.deepEqual(safeProgress({ completed: 0, submitted: 0, total: null, unit: '题' }), { completed: 0, submitted: 0, total: null, unit: '题' });
    assert.equal(safeProgress({ completed: -1, submitted: '5', total: Infinity }), null);
    assert.equal(safeProgress(null), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
