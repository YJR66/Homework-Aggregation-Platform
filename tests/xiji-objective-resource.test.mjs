import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { readXijiObjectiveState, collectXijiDetails } from '../server/xiji.mjs';

const root = 'https://vpn.neuq.edu.cn/https/77726476706e69737468656265737421f3f444902632265e7b1d98e29d51367b0755/';
const target = `${root}assignment/singleOptionList.jsp?assignID=915&proNum=1`;
const key = 'optSingleOptions0_1145072194e800f9ce9d463e66c5a8eb3947b';
const resourceUrl = `${root}downMarkdown?mkdoc=${key}`;
const overviewUrl = `${root}assignment/index.jsp?assignID=915`;
const renderer = '<script src="/includes/cherrymd/mdPreview.v4.js"></script>';
const renderCall = `<script>cgRenderMarkdown('${key}',false,'cgmdoptSingleOptions0_11450');</script>`;
const container = '<div id="cgmdoptSingleOptions0_11450"></div>';
const form = (content = container + renderCall) => `<form name="answerForm11450" action="stuAnswerHandler.jsp" method="post"><input type="hidden" name="problemID" value="11450"><input type="hidden" name="assignID" value="915">${content}</form>`;
const personal = () => renderer + form();
const choices = (selected = []) => ['A', 'B', 'C', 'D'].map(value => `<label><input type="radio" name="answer1" id="cgsingleOpt0_11450${value}" value="${value}" ${selected.includes(value) ? 'checked' : ''} onclick="this.form.submit()">${value}.</label>`).join('\n');

test('Xiji objective resources require a complete personal-form binding and are always read-only', async t => {
  const executablePath = [process.env.HOMEWORK_BROWSER_PATH,
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    chromium.executablePath()].find(value => value && existsSync(value));
  if (!executablePath) return t.skip('没有本机 Chromium，跳过离线 DOM fixture');
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let question = personal(); let markdown = choices(); let redirect = false;
  let resourceFailures = 0; let emptyResources = 0; let overviewHref = target; let overviewText = '';
  const requests = [];
  await context.route('**/*', async route => {
    const request = route.request();
    requests.push({ method: request.method(), url: request.url() });
    if (request.method() !== 'GET') return route.abort();
    if (request.url() === target) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: question });
    if (request.url() === resourceUrl) {
      if (resourceFailures > 0) { resourceFailures--; return route.fulfill({ status: 503, body: 'Temporary offline fixture' }); }
      if (emptyResources > 0) { emptyResources--; return route.fulfill({ contentType: 'text/plain', body: '' }); }
      return redirect
        ? route.fulfill({ status: 302, headers: { location: 'https://evil.example/downMarkdown?mkdoc=foreign' } })
        : route.fulfill({ contentType: 'text/plain; charset=utf-8', body: markdown });
    }
    if (request.url() === `${root}main.jsp`) return route.fulfill({ contentType: 'text/html', body: '<h1>Offline harness</h1>' });
    if (request.url() === overviewUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<p>作业满分：100，共 2 道题。</p><table><thead><tr><th>题目</th><th>提交状态</th></tr></thead><tbody>
      <tr><td><a href="${overviewHref}">目标题目</a></td><td>${overviewText}</td></tr>
      <tr><td><a href="${root}assignment/programList.jsp?assignID=915&proNum=2">已读取题目</a></td><td>还未提交代码</td></tr>
      </tbody></table>` });
    return route.abort();
  });
  const page = await context.newPage();
  try {
    await page.goto(`${root}main.jsp`);
    await page.evaluate(() => {
      const nativeFetch = window.fetch;
      window.__fixtureResponseUrls = {};
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const reported = window.__fixtureResponseUrls[String(args[0])];
        if (reported) Object.defineProperty(response, 'url', { value: reported });
        return response;
      };
    });
    requests.length = 0;
    async function read(html = personal(), content = choices()) {
      question = html; markdown = content; requests.length = 0; redirect = false;
      const result = await readXijiObjectiveState(page, target, '915');
      assert.equal(requests.every(request => request.method === 'GET'), true);
      assert.equal(await page.locator('h1').innerText(), 'Offline harness', 'neither fetched DOM is attached to the live page');
      return result;
    }
    await t.test('bound personal resource with no checked radio proves an empty answer', async () => {
      assert.deepEqual(await read(), { verified: true, fields: 1, filled: 0, status: '' });
      assert.deepEqual(requests, [{ method: 'GET', url: target }, { method: 'GET', url: resourceUrl }]);
    });
    await t.test('checked state comes from controls, never the zero in the resource key', async () => {
      assert.deepEqual(await read(personal(), choices(['B'])), { verified: true, fields: 1, filled: 1, status: '' });
    });
    await t.test('the exact empty WebVPN transport marker is accepted without a redirect', async () => {
      await page.evaluate(({ target, resourceUrl }) => {
        window.__fixtureResponseUrls = {
          [target]: target + '&vpn-12-o2-ccelab.neuq.edu.cn',
          [resourceUrl]: resourceUrl + '&vpn-12-o2-ccelab.neuq.edu.cn=',
        };
      }, { target, resourceUrl });
      assert.deepEqual(await read(), { verified: true, fields: 1, filled: 0, status: '' });
      assert.deepEqual(await read(form('<input name="answer1" value="saved">')),
        { verified: true, fields: 1, filled: 1, status: '' }, 'static personal forms use the same transport rule');
      await page.evaluate(() => { window.__fixtureResponseUrls = {}; });
    });
    await t.test('transport normalization rejects changed business parameters and unknown or duplicate markers', async () => {
      for (const reported of [target + '&vpn-12-o2-ccelab.neuq.edu.cn=nonempty',
        target + '&vpn-12-o2-ccelab.neuq.edu.cn=&vpn-12-o2-ccelab.neuq.edu.cn=',
        target + '&vpn-12-o2-other.example=', target + '&assignID=915', target + '&unobserved=1',
        target.replace('assignID=915', 'assignID=916'), target.replace('&proNum=1', ''),
        target.replace('vpn.neuq.edu.cn', 'evil.example'), target.replace('singleOptionList.jsp', 'optionList.jsp')]) {
        await page.evaluate(({ target, reported }) => { window.__fixtureResponseUrls = { [target]: reported }; }, { target, reported });
        await assert.rejects(read());
        assert.deepEqual(requests, [{ method: 'GET', url: target }]);
      }
      await page.evaluate(() => { window.__fixtureResponseUrls = {}; });
    });
    await t.test('templates and bindings outside the personal form remain unknown', async () => {
      for (const html of [renderer + choices(), renderer + form(container), renderer + form(container) + renderCall,
        renderer + form(renderCall) + container, renderer + form(container + renderCall + renderCall)]) {
        assert.equal((await read(html)).verified, false);
        assert.deepEqual(requests, [{ method: 'GET', url: target }]);
      }
    });
    await t.test('foreign renderers and ambiguous or incorrect identity are rejected before resource reads', async () => {
      for (const html of [personal().replace('/includes/cherrymd/', 'https://evil.example/includes/cherrymd/'),
        personal().replace('name="problemID" value="11450"', 'name="problemID" value="11451"'),
        personal().replace('name="assignID" value="915"', 'name="assignID" value="916"'),
        personal().replace('</form>', '<input type="hidden" name="assignID" value="916"></form>'),
        personal().replace(key, key.replace('11450', '11451')),
        personal().replace('cgmdoptSingleOptions0_11450\');', 'cgmdoptSingleOptions0_11451\');')]) {
        assert.equal((await read(html)).verified, false);
        assert.deepEqual(requests, [{ method: 'GET', url: target }]);
      }
    });
    await t.test('wrong problem controls, duplicate options and multiple checked radios remain unknown', async () => {
      for (const content of [choices(['A', 'B']), choices().replaceAll('cgsingleOpt0_11450', 'cgsingleOpt0_11451'),
        choices().replace('value="B"', 'value="A"'), choices().replace('name="answer1"', 'name="answer2"'),
        choices().replace('type="radio"', 'type="checkbox"')]) {
        assert.equal((await read(personal(), content)).verified, false);
      }
    });
    await t.test('scripts are never executed and answer handlers never receive a POST', async () => {
      assert.equal((await read(personal(), choices(['A']) + '<script>window.__fixtureExecuted=true;fetch("stuAnswerHandler.jsp",{method:"POST"})</script>')).verified, false);
      assert.equal(await page.evaluate(() => window.__fixtureExecuted), undefined);
      assert.deepEqual(requests, [{ method: 'GET', url: target }, { method: 'GET', url: resourceUrl }]);
    });
    await t.test('resource redirects cannot escape the same-origin read-only endpoint', async () => {
      question = personal(); markdown = choices(); redirect = true; requests.length = 0;
      await assert.rejects(readXijiObjectiveState(page, target, '915'));
      assert.deepEqual(requests, [{ method: 'GET', url: target }, { method: 'GET', url: resourceUrl }]);
      redirect = false;
    });
    await t.test('the original static personal cloze form remains readable without a markdown request', async () => {
      assert.deepEqual(await read(form('<input name="answer1" value="saved"><input name="answer2" value="">')),
        { verified: true, fields: 2, filled: 1, status: '' });
      assert.deepEqual(requests, [{ method: 'GET', url: target }]);
    });
    const collect = async () => {
      requests.length = 0; question = personal(); markdown = choices(); redirect = false;
      const result = await collectXijiDetails(page, { title: 'Offline objective fixture', url: overviewUrl });
      assert.equal(requests.every(request => request.method === 'GET'), true, 'all reads and retries must remain GET-only');
      return result;
    };
    const countReads = url => requests.filter(request => request.url === url).length;
    await t.test('a transient GET failure retries the personal objective read exactly once and recovers', async () => {
      resourceFailures = 1;
      const result = await collect();
      assert.equal(result.status, 'pending');
      assert.notEqual(result.detailComplete, false);
      assert.deepEqual(result.progress, { total: 2, submitted: 0, unit: '题' });
      assert.equal(countReads(target), 2);
      assert.equal(countReads(resourceUrl), 2);
    });
    await t.test('an initially unverified empty resource is re-read once without altering its safety checks', async () => {
      emptyResources = 1;
      const result = await collect();
      assert.equal(result.status, 'pending');
      assert.notEqual(result.detailComplete, false);
      assert.deepEqual(result.progress, { total: 2, submitted: 0, unit: '题' });
      assert.equal(countReads(target), 2);
      assert.equal(countReads(resourceUrl), 2);
    });
    await t.test('two failed or unverified objective reads stop and preserve incomplete details', async () => {
      for (const mode of ['error', 'empty']) {
        resourceFailures = mode === 'error' ? 2 : 0;
        emptyResources = mode === 'empty' ? 2 : 0;
        const result = await collect();
        assert.equal(result.detailComplete, false);
        assert.equal(result.status, 'pending');
        assert.equal(Object.hasOwn(result.progress, 'submitted'), false);
        assert.equal(countReads(target), 2);
        assert.equal(countReads(resourceUrl), 2);
      }
    });
    await t.test('known answer states and unsupported programming forms never enter objective retry logic', async () => {
      overviewText = '已提交';
      const known = await collect();
      assert.notEqual(known.detailComplete, false);
      assert.deepEqual(known.progress, { total: 2, submitted: 1, unit: '题' });
      assert.deepEqual(requests, [{ method: 'GET', url: overviewUrl }]);
      overviewText = ''; overviewHref = `${root}assignment/programList.jsp?assignID=915&proNum=1`;
      const unsupported = await collect();
      assert.equal(unsupported.detailComplete, false);
      assert.deepEqual(requests, [{ method: 'GET', url: overviewUrl }]);
      overviewHref = target;
    });
  } finally { await browser.close(); }
});
