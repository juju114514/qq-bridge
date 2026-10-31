/**
 * sidecar 客户端（插件侧）：把 N2 的 4 个端点包成几个方法。
 *
 * 为什么要有它：
 *   · token / bearer 头 / ETag 缓存 这些细节如果散在工具里，每个工具都要重写一遍
 *   · sidecar 不在时要**快速失败**（1.5s 超时），不能让模型等 30 秒
 *
 * 不做重试：工具调用本来就短，重试会把"降级"变成"卡住"。
 */

export function createSidecarClient({
  baseUrl = 'http://127.0.0.1:3100',
  token = '',
  timeoutMs = 1500,
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const cache = new Map(); // key -> { etag, state }

  async function request(path, { method = 'GET', body, headers = {}, noAuth = false } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, {
        method,
        signal: ac.signal,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(noAuth || !token ? {} : { authorization: 'Bearer ' + token }),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, headers: res.headers, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async function health() {
    try {
      const r = await request('/health', { noAuth: true });
      return { ok: r.status === 200 && r.json?.ok === true, ...(r.json ?? {}) };
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) };
    }
  }

  /** 拉快照；命中 ETag 时返回 { notModified: true, state: 上次的 state }。 */
  async function snapshot(key) {
    const cached = cache.get(key);
    const headers = cached?.etag ? { 'if-none-match': cached.etag } : {};
    const r = await request('/snapshot?key=' + encodeURIComponent(key), { headers });
    if (r.status === 304 && cached) return { ok: true, notModified: true, etag: cached.etag, state: cached.state };
    if (r.status !== 200 || !r.json?.ok) {
      return { ok: false, status: r.status, error: r.json?.error ?? 'snapshot failed' };
    }
    cache.set(key, { etag: r.json.etag, state: r.json.state });
    return { ok: true, notModified: false, etag: r.json.etag, state: r.json.state };
  }

  async function postIntent({ key, intent, payload = {} }) {
    const r = await request('/intents', { method: 'POST', body: { key, intent, payload } });
    if (r.status !== 202 || !r.json?.ok) {
      throw new Error(r.json?.error ?? `intent ${intent} failed (${r.status})`);
    }
    return r.json;
  }

  async function postEvent(event) {
    try {
      const r = await request('/events', { method: 'POST', body: event });
      return r.status === 202;
    } catch (e) {
      log('事件上报失败（不影响消息）：' + (e?.message ?? e));
      return false;
    }
  }

  return { health, snapshot, postIntent, postEvent, get baseUrl() { return base; } };
}