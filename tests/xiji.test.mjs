import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXijiCard, xijiProxyUrl, xijiQuestionState, normalizeXijiDetails, normalizeXijiPartialDetails, readXijiObjectiveState, verifyXijiQuestionCoverage, xijiAssignmentTotal, normalizeXijiPracticeDetails, extractXijiPracticeSnapshot, collectXijiDetails } from '../server/xiji.mjs';
import { trustedAuthFormAction } from '../server/browser.mjs';
const root = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const details = rows => ({ total: rows.length, assignID: '915', rows: rows.map((row, i) => ({ href: `/assignment/programList.jsp?assignID=915&proNum=${i+1}`, ...row })) });

test('希冀作业页与 selfindex 练习页的题数标签均可识别', () => {
 assert.equal(xijiAssignmentTotal('作业满分：100.00，共 22 道题。'), 22);
 assert.equal(xijiAssignmentTotal('总分值：460.00，共46道题。 总得分：0.00'), 46);
 assert.equal(xijiAssignmentTotal('总分值：100.00，共2道题。 总得分：100.00'), 2);
 assert.equal(xijiAssignmentTotal('总分值: 450.00，\n共 45 道题。'), 45);
 assert.equal(xijiAssignmentTotal('统一身份认证 请输入密码'), null);
 assert.equal(xijiAssignmentTotal('参考答案 共46道'), null);
});

const practice = (assignID, total, rows) => ({ assignID, total, rows,
 sourceUrl: `${root}assignment/index.jsp?assignID=${assignID}`,
 url: `${root}assignment/selfindex.jsp?assignID=opaque-server-redirect` });

test('真实 selfindex 练习进度 0/44 + 0/2 不伪造逐题未提交状态', () => {
 const result = normalizeXijiPracticeDetails(practice('722', 46, [
  { id: 'indexProsByKindDIV64_722', progressText: '0 / 44' },
  { id: 'indexProsByKindDIV16_722', progressText: '0 / 2' }
 ]));
 assert.equal(result.status, 'in_progress');
 assert.equal(result.statusLabel, '练习待完成（0/46 题）');
 assert.deepEqual(result.progress, { completed: 0, total: 46, unit: '题' });
 assert.equal(result.detailComplete, true);
 assert.equal(Object.hasOwn(result.progress, 'submitted'), false);
 assert.match(result.statusEvidence, /不是逐题提交次数/);
 assert.equal(normalizeXijiPracticeDetails(practice('933', 45, [{ id: 'indexProsByKindDIV64_933', progressText: '0 / 45' }])).status, 'in_progress');
});

test('个人练习完整进度 2/2 才能进入云端已完成，部分完成仍为进行中', () => {
 const snapshot = practice('891', 2, [{ id: 'indexProsByKindDIV16_891', progressText: '2 / 2' }]);
 const result = normalizeXijiPracticeDetails(snapshot);
 assert.equal(result.status, 'completed');
 assert.equal(result.statusLabel, '练习已完成（2/2 题）');
 assert.deepEqual(result.progress, { completed: 2, total: 2, unit: '题' });
 const partial = normalizeXijiPracticeDetails({ ...snapshot, rows: [{ ...snapshot.rows[0], progressText: '1 / 2' }] });
 assert.equal(partial.status, 'in_progress');
 assert.equal(partial.statusLabel, '练习待完成（1/2 题）');
});

test('练习概览必须来源正确作业的受信任 selfindex 跳转', () => {
 const snapshot = practice('891', 2, [{ id: 'indexProsByKindDIV16_891', progressText: '2 / 2' }]);
 for (const patch of [
  { url: 'https://evil.example/assignment/selfindex.jsp?assignID=opaque' },
  { url: `${root}assignment/index.jsp?assignID=891` },
  { url: `${root}assignment/selfindex.jsp` },
  { url: `${root}assignment/selfindex.jsp?assignID=a&assignID=b` },
  { sourceUrl: `${root}assignment/index.jsp?assignID=722` },
  { sourceUrl: `${root}assignment/index.jsp?assignID=891&assignID=891` },
  { sourceUrl: `${root}assignment/selfindex.jsp?assignID=891` }
 ]) assert.equal(normalizeXijiPracticeDetails({ ...snapshot, ...patch }), null);
});

test('练习题型行总量、唯一题型与作业归属均须完整校验', () => {
 const snapshot = practice('722', 46, [
  { id: 'indexProsByKindDIV64_722', progressText: '0 / 44' },
  { id: 'indexProsByKindDIV16_722', progressText: '0 / 2' }
 ]);
 for (const rows of [
  snapshot.rows.slice(0, 1),
  [snapshot.rows[0], { ...snapshot.rows[1], id: 'indexProsByKindDIV64_722' }],
  [snapshot.rows[0], { ...snapshot.rows[1], id: 'indexProsByKindDIV16_891' }],
  [snapshot.rows[0], { ...snapshot.rows[1], progressText: '3 / 2' }],
  [snapshot.rows[0], { ...snapshot.rows[1], progressText: '100%' }],
  [snapshot.rows[0], { ...snapshot.rows[1], progressText: '已得分 0 / 2' }],
  [snapshot.rows[0], { ...snapshot.rows[1], progressText: '0 / 0' }]
 ]) assert.equal(normalizeXijiPracticeDetails({ ...snapshot, rows }), null);
});

test('练习跳转只读取个人概览，不点击开始练习或加载作答表单', async () => {
 const item = { url: `${root}assignment/index.jsp?assignID=891`, title: '【练习】线性表的基本操作' };
 let evaluated = 0;
 const page = {
  goto: async (url) => { assert.equal(url, item.url); return { status: () => 200 }; },
  url: () => `${root}assignment/selfindex.jsp?assignID=opaque-server-redirect`,
  waitForFunction: async (fn, pattern) => { assert.match('总分值：100.00，共2道题。 总得分：100.00', new RegExp(pattern)); },
  evaluate: async (fn) => {
   evaluated++;
   assert.equal(fn, extractXijiPracticeSnapshot);
   return { body: '总分值：100.00，共2道题。 总得分：100.00', rows: [{ id: 'indexProsByKindDIV16_891', progressText: '2 / 2' }] };
  },
  locator: () => assert.fail('must not interact with exercise controls')
 };
 const result = await collectXijiDetails(page, item);
 assert.equal(result.status, 'completed');
 assert.equal(result.url, item.url);
 assert.equal(evaluated, 1);
});
test('希冀只转换已确认原站的 WebVPN 地址',()=>{
 assert.equal(xijiProxyUrl('assignment/index.jsp?assignID=915'),root+'assignment/index.jsp?assignID=915');
 assert.equal(xijiProxyUrl('https://ccelab.neuq.edu.cn/main.jsp'),root+'main.jsp');
 assert.equal(xijiProxyUrl('/courselist.jsp?courseID=52'),root+'courselist.jsp?courseID=52');
 assert.equal(xijiProxyUrl('https://evil.example/main.jsp'),'');
 assert.equal(xijiProxyUrl('javascript:alert(1)'),'');
});
test('希冀课程卡片截止取时间区间终点，不把时间进度当提交状态',()=>{
 const item=normalizeXijiCard({title:'【作业】栈和队列',time:'作业时间：2026-09-16 12:38:00 - 2026-10-11 09:07:00',href:'assignment/index.jsp?assignID=915',progress:77},{id:'52',name:'数据结构'});
 assert.equal(item.dueAt,'2026-10-11T01:07:00.000Z'); assert.equal(item.status,'unknown'); assert.equal(item.externalId,'xiji:52:915');
 assert.equal(normalizeXijiCard({title:'新闻',href:'index.jsp'},{id:'52'}),null);
 assert.equal(normalizeXijiCard({title:'新闻',href:'index.jsp?assignID=915'},{id:'52'}),null);
 assert.equal(normalizeXijiCard({title:'提交',href:'assignment/stuAnswerHandler.jsp?assignID=915'},{id:'52'}),null);
});
test('希冀登录只允许其准确原站 shim action',()=>{
 assert.equal(trustedAuthFormAction('xiji',root+'indexcs/simple.jsp','/login/loginproc.jsp'),true);
 assert.equal(trustedAuthFormAction('xiji',root+'indexcs/simple.jsp','https://ccelab.neuq.edu.cn/login/loginproc.jsp'),true);
 assert.equal(trustedAuthFormAction('xiji',root+'indexcs/simple.jsp','https://ccelab.neuq.edu.cn.evil/login/loginproc.jsp'),false);
 assert.equal(trustedAuthFormAction('xiji',root+'indexcs/simple.jsp','http://ccelab.neuq.edu.cn/login/loginproc.jsp'),false);
});

test('希冀以逐题提交记录核验，不把颜色或时间进度当完成',()=>{
 assert.deepEqual(xijiQuestionState({text:'还未提交代码'}),{submitted:false,fullyAnswered:false});
 assert.deepEqual(xijiQuestionState({text:'还未提交答案 详细'}),{submitted:false,fullyAnswered:false});
 assert.deepEqual(xijiQuestionState({text:'最后一次提交时间: 2026-09-18 23:08:05 得分：0.00'}),{submitted:true,fullyAnswered:true});
 assert.equal(xijiQuestionState({text:'',progress:100,className:'badge-success'}),null);
});

test('客观题空状态必须复核服务器已保存表单，不能只凭空标记判断',()=>{
 assert.equal(xijiQuestionState({text:''}),null);
 assert.deepEqual(xijiQuestionState({form:{verified:true,fields:2,filled:0}}),{submitted:false,fullyAnswered:false});
 assert.deepEqual(xijiQuestionState({form:{verified:true,fields:2,filled:1}}),{submitted:true,fullyAnswered:false});
 assert.deepEqual(xijiQuestionState({form:{verified:true,fields:2,filled:2}}),{submitted:true,fullyAnswered:true});
 assert.equal(xijiQuestionState({form:{verified:false,fields:2,filled:0}}),null);
 assert.equal(xijiQuestionState({form:{verified:true,fields:0,filled:0}}),null);
});

test('希冀明细必须等于平台公布题数，遇到不完整数据不制造状态',()=>{
 assert.equal(normalizeXijiDetails({total:3,rows:[{text:'还未提交代码'}]}),null);
 assert.equal(normalizeXijiDetails({total:1,rows:[{text:''}]}),null);
 assert.equal(normalizeXijiDetails({total:0,rows:[]}),null);
});

test('46道题全部明确未提交时给出准确未提交与0/46进度',()=>{
 const result=normalizeXijiDetails(details(Array.from({length:46},()=>({text:'下载参考代码 还未提交答案 详细'}))));
 assert.equal(result.status,'pending');
 assert.equal(result.statusLabel,'未提交（0/46 题）');
 assert.deepEqual(result.progress,{total:46,submitted:0,unit:'题'});
 assert.equal(result.detailComplete,true);
});

test('希冀部分提交与全部提交分开，零分提交仍是已提交',()=>{
 const result=normalizeXijiDetails(details([{text:'最后一次提交时间: 2026-09-18 23:08:05 得分：0.00'},{text:'还未提交代码'},{form:{verified:true,fields:3,filled:1}}]));
 assert.equal(result.status,'in_progress');
 assert.deepEqual(result.progress,{total:3,submitted:2,unit:'题'});
 assert.equal(result.detailComplete,true);
 assert.equal(normalizeXijiDetails(details([{text:'已提交'}])).status,'submitted');
 assert.equal(Object.hasOwn(result.progress,'completed'),false);
});

test('希冀题目覆盖校验必须题型+题号唯一且属于同一作业',()=>{
 const value=details([{text:'还未提交代码'},{text:'还未提交代码'}]);
 assert.equal(verifyXijiQuestionCoverage(value),true);
 assert.equal(verifyXijiQuestionCoverage({...value,rows:[value.rows[0],value.rows[0]]}),false);
 assert.equal(verifyXijiQuestionCoverage({...value,rows:[value.rows[0],{...value.rows[1],href:'/assignment/programList.jsp?assignID=913&proNum=2'}]}),false);
 assert.equal(verifyXijiQuestionCoverage({...value,rows:[value.rows[0],{...value.rows[1],href:'/assignment/programList.jsp?assignID=915&proNum=2&proNum=3'}]}),false);
 assert.equal(verifyXijiQuestionCoverage({...value,rows:[value.rows[0],{...value.rows[1],href:'/assignment/clozeList.jsp?assignID=915&proNum=1'}]}),true);
});

test('单选模板不能确认个人答案，部分核验只显示确定的未完成证据',()=>{
 const snapshot=details([...Array.from({length:21},()=>({text:'还未提交答案'})),{form:{verified:false,fields:1,filled:0}}]);
 assert.equal(normalizeXijiDetails(snapshot),null);
 const result=normalizeXijiPartialDetails(snapshot);
 assert.equal(result.status,'pending');
 assert.equal(result.statusLabel,'未完成（21 题明确未提交）');
 assert.deepEqual(result.progress,{total:22,unit:'题'});
 assert.equal(result.detailComplete,false);
 assert.match(result.statusEvidence,/1 题个人提交信息读取失败/);
});

test('全部明细失败时不猜未提交且不保留精确提交计数',()=>{
 const result=normalizeXijiPartialDetails(details([{text:''},{text:''}]));
 assert.equal(result.status,'unknown');
 assert.deepEqual(result.progress,{total:2,unit:'题'});
 assert.equal(Object.hasOwn(result.progress,'submitted'),false);
});

test('客观题只读验证拒绝提交地址、其他作业与不受信任域',async()=>{
 const page={url:()=>root+'assignment/index.jsp?assignID=915',evaluate:()=>assert.fail('invalid link must not access page')};
 for(const href of ['/assignment/stuAnswerHandler.jsp?assignID=915&proNum=1','/assignment/clozeList.jsp?assignID=913&proNum=1','https://evil.example/assignment/clozeList.jsp?assignID=915&proNum=1','/assignment/programList.jsp?assignID=915&proNum=1']) await assert.rejects(()=>readXijiObjectiveState(page,href,'915'));
});
