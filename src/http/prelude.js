/**
 * 请求前导（prelude）：在进入任何业务分支之前必须过的关。
 *
 * 从 bridge.js 的 `http.createServer` 回调里原样搬出来（2026-10 重构阶段 2）。
 * 这段代码是**安全边界**，搬运时逐行对照、文案与被拒状态码一字未改：
 *
 *   1. favicon / apple-touch-icon  → 204（浏览器自动请求，不该落进鉴权分支留 401 噪音）
 *   2. Host 头白名单               → 403（DNS rebinding：TTL=0 域名解析到 127.0.0.1 时，
 *                                    浏览器会把 evil.com:3100 当同源，Origin 校验随之失效）
 *   3. 控制台令牌（定长比较）        → 401（GET / 给一个 prompt 页，其余给 JSON）
 *   4. x-agent-call 声明             → 403（confused deputy：漏传令牌不能升级成管理端全权）
 *   5. CSRF：写操作必须 JSON + 本机 Origin → 415 / 403
 *   6. 空 agent token / 暂停 / 关停 / 模式 / 管理端专用 / 权限白名单 / 只读降级 → 403 / 503
 *
 * 设计：**只判定，不写响应**。返回 `null` 表示放行；返回 `{ status, json|html|empty }`
 * 表示拒绝，由调用方（`applyDenial`）落响应。这样判定逻辑可以在没有真实 res 的
 * 单测里跑，也能一眼看出「哪一条拒绝」。
 *
 * 约束（VM 注入）：不 import、无顶层 await。所有外部状态通过参数/getter 传入。
 */

/** Host 头允许值：控制台只监听回环，所以合法 Host 只有这三种 + 实际绑定端口。 */
export function allowedHosts(boundPort) {
  return [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
}

/**
 * 定长比较令牌。
 *
 * `!==` 会在第一个不同字符处短路，理论上可被本机进程用响应时延逐字节试探。
 * 令牌是 192 bit 随机值且只监听回环 ⇒ 这是纵深防御，不是在野漏洞。
 */
export function constantTimeEqual(crypto, a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 管理端专用 v2 接口（带 agent token 一律拒绝）。 */
export const ADMIN_ONLY_V2_PATHS = [
  '/api/socialV2/config',
  '/api/socialV2/activity',
  '/api/socialV2/reset',
  '/api/socialV2/states',
  '/api/socialV2/feedback',
];

/** 不带令牌的智能体调用只允许这些面（其余必须带有效会话令牌）。 */
export function tokenlessAgentAllowed(pathname) {
  return pathname === '/api/status'
    || pathname.startsWith('/api/send/')
    || pathname.startsWith('/api/images/');
}

/** 带令牌的智能体调用只允许这些面；其余一律 403（白名单，避免新增端点忘记拉黑）。 */
export function agentAllowed(pathname) {
  return pathname === '/api/status'
    || pathname.startsWith('/api/socialV2/')
    || pathname.startsWith('/api/send/')
    || pathname.startsWith('/api/images/')
    || pathname === '/api/authorize/read';
}

const deny = (status, error) => ({ status, json: { ok: false, error } });

/**
 * 跑一遍前导关。
 *
 * @param {object} ctx
 * @param {object} ctx.req                  IncomingMessage
 * @param {URL}    ctx.url                  已解析的 URL
 * @param {number} ctx.boundPort            实际监听端口（测试夹具用 0 让系统分配）
 * @param {string} ctx.consoleToken         控制台令牌（空串=未配置，首次启动会生成）
 * @param {object} ctx.crypto               node:crypto
 * @param {(t: string) => boolean} ctx.isLiveAgentToken
 * @param {() => boolean} ctx.isSocialV2Paused
 * @param {() => boolean} ctx.isSocialV2Disabled
 * @param {() => string}  ctx.getMode
 * @param {boolean} ctx.slangStoreWritable
 * @param {boolean} ctx.stickerStoreWritable
 * @returns {null | { status: number, json?: object, html?: string, empty?: boolean }}
 */
export function runPrelude(ctx) {
  const {
    req, url, boundPort, consoleToken, crypto, isLiveAgentToken,
    isSocialV2Paused, isSocialV2Disabled, getMode,
    slangStoreWritable, stickerStoreWritable,
  } = ctx;
  const pathname = url.pathname;

  // 1) 浏览器自动请求：直接 204，别让它落到鉴权分支
  if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/apple-touch-icon.png')) {
    return { status: 204, empty: true };
  }

  // 2) Host 头（DNS rebinding 硬化）
  const hostHeader = String(req.headers.host ?? '');
  const hosts = allowedHosts(boundPort);
  if (!hosts.includes(hostHeader.toLowerCase())) {
    return deny(403, `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问`);
  }

  // 3) 控制台令牌
  const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
  const tokenMatches = consoleToken
    ? constantTimeEqual(crypto, suppliedToken, consoleToken)
    : false;
  if (consoleToken && !tokenMatches) {
    if (req.method === 'GET' && pathname === '/') {
      return {
        status: 401,
        html: '<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>',
      };
    }
    return deny(401, '未授权：请提供控制台访问令牌');
  }

  // 4) 智能体调用声明（confused deputy 的集中关卡）
  if (req.headers['x-agent-call'] !== undefined) {
    const agentToken = req.headers['x-agent-token'];
    const hasToken = typeof agentToken === 'string' && agentToken !== '';
    if (hasToken && !isLiveAgentToken(agentToken)) {
      return deny(403, '未授权：智能体调用携带的会话令牌无效');
    }
    if (!hasToken && !tokenlessAgentAllowed(pathname)) {
      return deny(403, '未授权：该接口的智能体调用必须携带有效的会话令牌');
    }
  }

  // 5) CSRF：写操作必须 application/json，且（若带 Origin）必须来自本机页面
  if (req.method !== 'GET') {
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.toLowerCase().includes('application/json')) {
      return deny(415, '请求必须是 application/json');
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(String(origin)).host; } catch { /* 非法 Origin 当空处理 → 拒绝 */ }
      if (!hosts.includes(originHost)) return deny(403, '跨站请求被拒绝');
    }
  }

  // 6) 业务侧闸门
  //    空 agent token 一律拒绝：MCP 传空字符串时不能退化成"无 token"
  if (req.headers['x-agent-token'] === '') {
    return deny(403, 'agent token 不能为空');
  }
  const agentToken = req.headers['x-agent-token'];
  const isV2 = pathname.startsWith('/api/socialV2/') || pathname.startsWith('/api/socialV2');
  if (agentToken && isSocialV2Paused() && isV2) {
    return deny(403, 'AI 已暂停，当前不允许执行 v2 工具');
  }
  if (agentToken && isSocialV2Disabled() && isV2) {
    return deny(403, '二代模式已关闭，当前不允许执行 v2 工具');
  }
  if (agentToken && pathname.startsWith('/api/socialV2/') && getMode() !== 'reserved2') {
    return deny(403, '该接口仅 reserved2 模式可用');
  }
  if (agentToken && (ADMIN_ONLY_V2_PATHS.includes(pathname)
    || (pathname === '/api/socialV2/initial-prompt' && req.method === 'GET'))) {
    return deny(403, '该接口仅控制台可用');
  }
  if (agentToken && (pathname === '/api/stickers' || pathname.startsWith('/api/stickers/'))) {
    return deny(403, '该接口仅控制台可用');
  }
  if (agentToken && !agentAllowed(pathname)) {
    return deny(403, '该接口仅控制台可用');
  }

  // 7) 只读降级：黑话库/表情库启动加载失败时，写接口必须**明确失败**
  //    （旧行为是 save 只打日志、接口回 {ok:true}，控制台显示"已保存"但重启就没了）
  if (req.method !== 'GET') {
    const readonlyStore = (!slangStoreWritable && (pathname === '/api/slang'
      || pathname === '/api/slang/clear'
      || pathname === '/api/slang/extract'
      || pathname === '/api/slang/research'
      || pathname.startsWith('/api/slang/batch-')
      || pathname === '/api/socialV2/slang/submit')) ? '黑话库'
      : (!stickerStoreWritable && (pathname === '/api/stickers/sync'
        || pathname === '/api/stickers/note'
        || pathname === '/api/stickers/remark'
        || pathname === '/api/socialV2/sticker-note'
        || pathname === '/api/socialV2/sticker-remark'
        || pathname === '/api/socialV2/collect-sticker')) ? '表情库'
        : '';
    if (readonlyStore) {
      return deny(503, `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接`);
    }
  }

  return null;
}
