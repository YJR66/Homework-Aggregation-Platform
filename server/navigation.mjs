import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_NETWORK = /net::ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED|EMPTY_RESPONSE)\b/;

export function isTransientNavigationError(error) {
  return TRANSIENT_NETWORK.test(String(error?.message || '')) || error?.name === 'TimeoutError'
    || /(?:page|frame)\.goto: Timeout \d+ms exceeded/.test(String(error?.message || ''))
    || error?.code === 'READ_ONLY_TEMPORARY_HTTP';
}

/** Retry only verified read-only page navigations, never forms or action clicks. */
export async function gotoReadOnly(page, url, options = {}, { maxAttempts = 3, delayMs = 1000, sleep = delay } = {}) {
  const attempts = Math.min(3, Math.max(1, Math.trunc(maxAttempts) || 1));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await page.goto(url, options);
      if ([502, 503, 504].includes(response?.status?.())) {
        const error = new Error('平台暂时无法响应请求。');
        error.code = 'READ_ONLY_TEMPORARY_HTTP';
        throw error;
      }
      return response;
    } catch (error) {
      if (attempt + 1 >= attempts || page.isClosed?.() || !isTransientNavigationError(error)) throw error;
      await sleep(Math.max(0, delayMs) * (attempt + 1));
    }
  }
}

export function syncFailureMessage(error) {
  if (isTransientNavigationError(error)) return '平台连接暂时异常，已保留原有清单。请稍后重试，无需重新登录。';
  // Browser exceptions often contain signed URLs and ANSI call logs. Keep those
  // out of the dashboard even when the credential vault cannot redact them.
  if (/net::ERR_|(?:page|frame)\.goto:/.test(String(error?.message || ''))) return '平台页面连接失败，已保留原有清单；请检查网络后重试。';
  return `读取失败：${String(error?.message || '未知错误').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 240)}`;
}
