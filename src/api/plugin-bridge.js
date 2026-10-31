// sidecar 契约（N2）：插件 ↔ 常驻进程之间的 4 个端点。
//
// 设计依据：docs/design/plugin-mode-2026-10-31.md 第 6 节。
//   GET  /health              探活 + 当前模式
//   GET  /snapshot?key=       会话快照（带 ETag，每轮都要拉，不能每次回 30KB）
//   POST /events              入站/出站/工具事件（落 JSONL，可回放）
//   POST /intents             状态变更意图（记忆交接、已读水位、记账…）
//
// 认证：`Authorization: Bearer <plugin-token>` 或 `X-Plugin-Token`。
// 只监听回环地址（与 console 同一个 server），token 放 state/plugin-token。
//
// 这个文件只做「解析请求 + 调注入进来的能力」，所有 IO 都由 deps 提供 —— 这样才能离线测。

import crypto from 'node:crypto';

export function createPluginBridgeHandler(deps = {}) {
  const {
    sendJson, readBody, log = () => {},
    pluginToken,
    consoleToken,
    version = '0.0.0',
    startedAt = Date.now(),
    mode = 'bridge',
    getSocialV2State = () => ({}),
    readRoleState = () => ({ role: null }),
    roleHint = () => '',
    peopleSummary = () => null,
    readMemory = () => '',
    writeMemory = () => {},
    appendEvent = () => {},
    applyIntent = null,
  } = deps;

  function authorized(req) {
    const want = String(pluginToken || consoleToken || '');
    if (!want) return false;
    const auth = String(req.headers?.authorization ?? '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const header = String(req.headers?.['x-plugin-token'] ?? '').trim();
    const got = bearer || header;
    if (!got || got.length !== want.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    } catch {
      return false;
    }
  }

  const etagOf = (obj) => '"' + crypto.createHash('sha1')
    .update(JSON.stringify(obj))
    .digest('base64url')
    .slice(0, 16) + '"';

  return async function handlePluginBridge(req, url) {
    const p = url.pathname;

    if (p === '/health') {
      // 指纹：让「现在跑的到底是哪套代码」可追溯（version / commit / presetHash）
      const fp = typeof deps?.buildInfo === 'function' ? deps.buildInfo() : null;
      sendJson({ ok: true, mode, version, startedAt, uptimeMs: Date.now() - startedAt, ...(fp ?? {}) }, 200);
      return true;
    }

    if (p === '/snapshot' || p === '/events' || p === '/intents') {
      if (!authorized(req)) {
        sendJson({ ok: false, error: 'unauthorized' }, 401);
        return true;
      }
    }

    if (req.method === 'GET' && p === '/snapshot') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      const st = getSocialV2State(key) ?? {};
      const role = readRoleState() ?? {};
      const memory = String(readMemory(key) ?? '');
      const snapshot = {
        key,
        role: { name: role.role ?? null, hint: roleHint() },
        people: peopleSummary(key),
        wake: st.wakeConfig ?? null,
        recent: Array.isArray(st.recent) ? st.recent.slice(-20) : [],
        memory: { bytes: Buffer.byteLength(memory, 'utf8'), text: memory },
      };
      const etag = etagOf(snapshot);
      const inm = String(req.headers?.['if-none-match'] ?? '').trim();
      if (inm && inm === etag) { sendJson({ ok: true, etag, notModified: true }, 304); return true; }
      sendJson({ ok: true, etag, state: snapshot }, 200, { ETag: etag });
      return true;
    }

    if (req.method === 'POST' && p === '/events') {
      let body = {};
      try { body = await readBody(); } catch { body = {}; }
      try {
        appendEvent(body);
        sendJson({ ok: true }, 202);
      } catch (e) {
        log('plugin /events 落盘失败：' + (e?.message ?? e));
        sendJson({ ok: false, error: 'append failed' }, 500);
      }
      return true;
    }

    if (req.method === 'POST' && p === '/intents') {
      let body = {};
      try { body = await readBody(); } catch { body = {}; }
      const key = String(body?.key ?? '').trim();
      const intent = String(body?.intent ?? '').trim();
      if (!key || !intent) { sendJson({ ok: false, error: 'key / intent 不能为空' }, 400); return true; }
      try {
        const result = typeof applyIntent === 'function'
          ? await applyIntent({ key, intent, payload: body.payload ?? {} })
          : { applied: 0, note: 'no intent handler' };
        sendJson({ ok: true, ...result }, 202);
      } catch (e) {
        log('plugin /intents 失败：' + (e?.message ?? e));
        sendJson({ ok: false, error: String(e?.message ?? e) }, 500);
      }
      return true;
    }

    return false;
  };
}