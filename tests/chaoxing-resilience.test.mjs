import test from 'node:test';
import assert from 'node:assert/strict';
import { collectChaoxingAssignments } from '../server/chaoxing.mjs';

const HOME = 'https://i.chaoxing.com/';
const LOGIN = 'https://passport2.chaoxing.com/login?refer=https%3A%2F%2Fi.chaoxing.com%2F';
const COURSE = 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=';
const WORKS = 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/list';

function fixture({ directoryAvailableFrom = 1, recognized = true, login = false, entryError = false, courseErrors = [], courseLogins = [], courses = 1, folderCount = 0 } = {}) {
  const pages = [];
  const courseRows = Array.from({ length: courses }, (_, index) => ({
    title: `课程 ${index + 1}`, courseId: String(index + 1), classId: '20', closed: false, url: COURSE + (index + 1),
  }));
  function makePage(listing) {
    const state = { href: 'about:blank', entryAttempts: 0, courseAttempts: {}, selected: 0, menuClicks: 0, closed: false };
    const page = {
      state,
      url: () => state.href,
      async goto(url) {
        if (url === HOME) {
          state.entryAttempts++;
          if (entryError) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
          state.href = login ? LOGIN : HOME;
        } else {
          state.selected = Number(new URL(url).searchParams.get('courseid'));
          state.courseAttempts[state.selected] = (state.courseAttempts[state.selected] || 0) + 1;
          if (courseErrors.includes(state.selected)) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
          state.href = courseLogins.includes(state.selected) ? LOGIN : url;
        }
        return null;
      },
      locator(selector) {
        return {
          first() { return this; },
          async waitFor() {},
          async isVisible() { return selector === 'input[type="password"]' && state.href === LOGIN; },
          async getAttribute(name) { return name === 'data-url' ? WORKS : null; },
          async click() { assert.equal(selector, 'a[title="作业"][data-url]'); state.menuClicks++; },
        };
      },
      frames() {
        if (listing) {
          if (state.entryAttempts < directoryAvailableFrom) return [];
          return [{
            url: () => 'https://mooc1.chaoxing.com/visit/interaction?type=personal',
            locator: page.locator,
            async evaluate(fn) {
              if (String(fn).includes('window.scrollTo')) return;
              return { recognized, courses: courseRows, rowCount: courseRows.length, folderCount, hasMore: false, filtered: false };
            },
          }];
        }
        return [{
          url: () => WORKS,
          locator: page.locator,
          async evaluate() {
            return {
              recognized: true, allFilter: true, total: 1, completed: 0, next: null,
              records: [{
                title: `作业 ${state.selected}`, statusText: '未交', timeText: '',
                url: `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=${state.selected}&classId=20&workId=100`,
              }],
            };
          },
        }];
      },
      async waitForTimeout() {},
      isClosed: () => state.closed,
      async close() { state.closed = true; },
    };
    pages.push(page);
    return page;
  }
  return { pages, context: { async newPage() { return makePage(pages.length === 0); } } };
}

async function collect(options) {
  const setup = fixture(options);
  const result = await collectChaoxingAssignments({ platform: { id: 'chaoxing' }, context: setup.context });
  assert.equal(setup.pages.every((page) => page.state.closed), true, 'all temporary pages must close');
  return { ...setup, result };
}

test('Chaoxing exhausted entry network retries do not claim authentication expired', async () => {
  const { result, pages } = await collect({ entryError: true });
  assert.equal(result.authenticated, null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.assignments, []);
  assert.equal(pages[0].state.entryAttempts, 3);
  assert.doesNotMatch(result.message, /登录.*失效/);
});

test('Chaoxing missing iframe retries only the directory, then keeps authentication unknown', async () => {
  const { result, pages } = await collect({ directoryAvailableFrom: Infinity });
  assert.equal(result.authenticated, null);
  assert.equal(result.complete, false);
  assert.equal(pages[0].state.entryAttempts, 2);
  assert.equal(pages.length, 1);
  assert.match(result.message, /保留原清单/);
});

test('Chaoxing unrecognized directory is a loading/schema failure, not logout', async () => {
  const { result, pages } = await collect({ recognized: false });
  assert.equal(result.authenticated, null);
  assert.equal(result.complete, false);
  assert.equal(pages[0].state.entryAttempts, 2);
});

test('Chaoxing explicit login page is the evidence required for authentication false', async () => {
  const { result, pages } = await collect({ login: true });
  assert.equal(result.authenticated, false);
  assert.equal(result.complete, false);
  assert.equal(pages[0].state.entryAttempts, 1);
});

test('Chaoxing recovered directory only completes after the course work totals are verified', async () => {
  const { result, pages } = await collect({ directoryAvailableFrom: 2 });
  assert.equal(result.authenticated, true);
  assert.equal(result.complete, true, result.message);
  assert.equal(result.assignments.length, 1);
  assert.equal(pages[0].state.entryAttempts, 2);
  assert.equal(pages[1].state.menuClicks, 1, 'only the read-only work menu may be clicked');
});

test('Chaoxing partial course network failure retains earlier items without complete coverage', async () => {
  const { result, pages } = await collect({ courses: 2, courseErrors: [2] });
  assert.equal(result.authenticated, true);
  assert.equal(result.complete, false);
  assert.equal(result.assignments.length, 1);
  assert.equal(pages[1].state.courseAttempts[2], 3);
});

test('Chaoxing mid-scan logout retains earlier items and reports an expired session', async () => {
  const { result } = await collect({ courses: 2, courseLogins: [2] });
  assert.equal(result.authenticated, false);
  assert.equal(result.complete, false);
  assert.equal(result.assignments.length, 1);
  assert.match(result.message, /登录在读取期间失效/);
});

test('Chaoxing recovered list with an unscanned folder never reports complete', async () => {
  const { result } = await collect({ directoryAvailableFrom: 2, folderCount: 1 });
  assert.equal(result.authenticated, true);
  assert.equal(result.complete, false);
  assert.equal(result.assignments.length, 1);
});
