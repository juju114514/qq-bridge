// /curate 客户端：桥接侧调用独立服务用（超时短、失败即跳过）。
//
// 设计：**fail-open** —— 策展服务挂了绝不能影响聊天。
// 所以任何异常都变成 { ok:false }，调用方拿到 false 就当没这回事。

export const CURATE_TIMEOUT_MS = 1200;

export async function askCurate({ meaning, relevance = 0, mood = '', tags = [], id = '' } = {}, opts = {}) {
  const { port = 3181, token = '', timeoutMs = CURATE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = opts;
  if (!token) return { ok: false, error: 'no-token' };
  if (!String(meaning || '').trim()) return { ok: false, error: 'no-meaning' };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/curate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ meaning, relevance, mood, tags, id }),
      signal: ctrl?.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: data?.error || 'http-error' };
    return { ok: true, decision: data };
  } catch (error) {
    return { ok: false, error: String(error?.name === 'AbortError' ? 'timeout' : (error?.message ?? error)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
