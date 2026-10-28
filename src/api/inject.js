// 外部触发入口：让 webhook / cron / 监控 能推动机器人做事。
//
//   POST /api/inject
//   Authorization: Bearer <inject-token>        （令牌在 state/inject-token，首次启动生成）
//   {
//     "key":  "group:official-<openid>" 或 "group:<群号>" / "private:<QQ号>",
//     "mode": "prompt" | "say",     // prompt=交给 AI 决定怎么说；say=直接发这句
//     "text": "构建 #123 失败了",
//     "source": "github-actions"    // 可选，写进活动日志便于溯源
//   }
//
// 鉴权为什么不复用控制台令牌：外部系统（CI、监控）不该持有能改配置的令牌。
// 这里用一把**只能注入消息**的独立令牌，且在 config.inject.enabled=false 时整体关闭。

import { randomBytes } from 'node:crypto';

export function createInjectHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getCfg,
    modeAllowed,
    appendActivity,
    deliverPrompt,     // (key, text, opts) => Promise<{ok, error?}>
    sendSay,           // (key, text) => Promise<void>
    CONV_KEY_RE,
    convId
  } = deps;

  const hits = new Map(); // 简单限流：token -> [timestamps]

  const tokenOk = (req) => {
    const cfg = getCfg() || {};
    const inj = cfg.inject || {};
    if (inj.enabled === false) return { ok: false, error: '外部触发未启用（config.inject.enabled=false）' };
    const expected = String(inj.token || '').trim();
    if (!expected) return { ok: false, error: '未配置 inject.token（state/inject-token）' };
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const header = String(req.headers['x-inject-token'] || '').trim();
    const got = bearer || header;
    if (!got) return { ok: false, error: '缺少令牌（Authorization: Bearer <inject-token>）' };
    // 定长比较，避免时序侧信道
    if (got.length !== expected.length) return { ok: false, error: '令牌无效' };
    let diff = 0;
    for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0 ? { ok: true } : { ok: false, error: '令牌无效' };
  };

  return async function handleInject(req, url) {
    if (url.pathname !== '/api/inject') return false;
    if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

    const auth = tokenOk(req);
    if (!auth.ok) {
      log(`[inject] 拒绝：${auth.error}`);
      sendJson({ ok: false, error: auth.error }, 401);
      return true;
    }

    const cfg = getCfg() || {};
    const limit = Math.max(1, Number(cfg.inject?.maxPerMinute) || 30);
    const now = Date.now();
    const list = (hits.get('t') || []).filter((t) => now - t < 60000);
    if (list.length >= limit) {
      sendJson({ ok: false, error: `触发过于频繁（${limit}/分钟）` }, 429);
      return true;
    }

    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const text = String(body.text ?? '').trim();
    const mode = String(body.mode ?? 'prompt').trim();
    const source = String(body.source ?? 'external').slice(0, 60);
    if (!key || !text) { sendJson({ ok: false, error: 'key / text 不能为空' }, 400); return true; }
    if (!['prompt', 'say'].includes(mode)) { sendJson({ ok: false, error: 'mode 只能是 prompt 或 say' }, 400); return true; }
    if (text.length > 2000) { sendJson({ ok: false, error: 'text 不能超过 2000 字' }, 400); return true; }

    const m = (CONV_KEY_RE ?? /^(group|private):(\d+|official-[A-Za-z0-9_-]+)$/).exec(key);
    if (!m) { sendJson({ ok: false, error: 'key 格式应为 group:<id> / private:<id>（官方为 official-<openid>）' }, 400); return true; }
    const kind = m[1];
    const id = convId ? convId(m[2]) : m[2];
    if (typeof id !== 'string' && !(Number.isFinite(id) && id > 0)) {
      sendJson({ ok: false, error: 'key 里的 id 非法' }, 400);
      return true;
    }
    // 用真实当前模式判断白名单（不是写死 chat）
    if (!modeAllowed(key, kind, id, cfg, deps.getMode?.() || 'chat')) {
      sendJson({ ok: false, error: '目标不在白名单/当前模式允许范围内' }, 403);
      return true;
    }

    list.push(now);
    hits.set('t', list);

    try {
      if (mode === 'say') {
        await sendSay(key, text);
        log(`[inject] say → ${key}（来源 ${source}）：${text.slice(0, 60)}`);
        appendActivity?.(`${key} [inject] ${source} 直发：${text.slice(0, 60)}`);
        sendJson({ ok: true, key, mode, injected: true });
      } else {
        const r = await deliverPrompt(key, text, { source });
        if (!r?.ok) {
          sendJson({ ok: false, error: `注入失败：${r?.error || '未知错误'}` }, 502);
          return true;
        }
        log(`[inject] prompt → ${key}（来源 ${source}）：${text.slice(0, 60)}`);
        appendActivity?.(`${key} [inject] ${source} 触发：${text.slice(0, 60)}`);
        sendJson({ ok: true, key, mode, injected: true });
      }
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  };
}

/** 生成一把外部触发令牌（首次启动时写入 state/inject-token）。 */
export function makeInjectToken() {
  return randomBytes(24).toString('hex');
}
