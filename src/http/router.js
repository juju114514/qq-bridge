/**
 * 极简路由表（重构第一阶段用）。
 *
 * 目标：把 bridge.js 里 100+ 条 `if (req.method === 'GET' && url.pathname === '/api/x')`
 * 换成「注册 → 匹配」两步，**行为完全不变**，只是查找从"翻几千行"变成"读一张表"。
 *
 * 设计取舍：
 *   · 不引入 Express/Koa —— 现有代码是裸 http server，换框架会连带改响应层
 *   · 匹配顺序 = 注册顺序（保持现有 if 链的优先级语义：精确在前、前缀在后）
 *   · 只做「匹配」，不做响应 —— handler 签名保持 (req, res, ctx)，原地搬迁
 *
 * 用法：
 *   const router = createRouter();
 *   router.get('/api/status', statusHandler);
 *   router.post('/api/slang/batch-confirm', slangConfirmHandler);
 *   router.use('/api/socialV2/', socialV2Handler);   // 前缀，handler 自己再分派
 *
 *   // 在主循环里：
 *   const m = router.match(req.method, url.pathname);
 *   if (m) return m.handler(req, res, { ...ctx, params: m.params });
 */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function normalizePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new TypeError(`路由路径必须以 / 开头，收到：${String(p)}`);
  }
  // 去掉结尾多余斜杠（保留根路径 '/'）
  return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') || '/' : p;
}

function compile(pattern) {
  // 支持 :param 与 * 两种占位；其它字符按字面量处理
  const keys = [];
  const source = normalizePath(pattern)
    .split('/')
    .map((seg) => {
      if (seg === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source}/?$`), keys };
}

export function createRouter() {
  /** @type {{method:string, pattern:string, kind:'exact'|'prefix'|'param', handler:Function, re?:RegExp, keys?:string[]}[]} */
  const table = [];
  /** @type {Function[]} 链式处理器（各自内部再分派，返回 true 即停止） */
  const chainHandlers = [];

  function add(method, pattern, handler, kind) {
    if (typeof handler !== 'function') {
      throw new TypeError(`handler 必须是函数：${method} ${pattern}`);
    }
    if (kind === 'prefix') {
      if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
        throw new TypeError(`前缀必须以 / 开头，收到：${String(pattern)}`);
      }
      // 保留原始写法（含结尾斜杠）：startsWith 语义必须和原 if 链完全一致
      table.push({ method, pattern, kind, handler, re: null, keys: null });
      return;
    }
    const { re, keys } = compile(pattern);
    table.push({ method, pattern, kind, handler, re, keys });
  }

  const api = {
    /** 精确匹配 */
    exact(method, pattern, handler) {
      add(String(method).toUpperCase(), pattern, handler, 'exact');
      return api;
    },
    /** 带 :param 的模板匹配 */
    param(method, pattern, handler) {
      add(String(method).toUpperCase(), pattern, handler, 'param');
      return api;
    },
    /** 前缀匹配（handler 自己再分派，对应现有 startsWith 分支） */
    use(pattern, handler) {
      add('ANY', pattern, handler, 'prefix');
      return api;
    },
    get(p, h) { return api.exact('GET', p, h); },
    post(p, h) { return api.exact('POST', p, h); },
    put(p, h) { return api.exact('PUT', p, h); },
    del(p, h) { return api.exact('DELETE', p, h); },

    /**
     * 注册一个「链式处理器」：**每条请求都会按注册顺序尝试**，返回 true 表示已处理。
     *
     * 这是接入现有代码的关键：从 bridge.js 拆出去的 12 个域（roles/slang/socialV2/…）
     * 各自内部按 pathname 分派、不认领时 return false。它们原本是一串
     * `if (await handleX(req, url)) return;`，用 chain() 注册进来语义完全等价
     * （顺序 = 注册顺序），不需要按前缀猜归属。
     */
    chain(handler) {
      if (typeof handler !== 'function') throw new TypeError('chain handler 必须是函数');
      chainHandlers.push(handler);
      return api;
    },

    /**
     * 派发一次请求：精确/模板 → 前缀 → 链式 → fallback。
     * @returns {Promise<boolean>} true=已处理；false=无人认领（调用方回 404）
     */
    async dispatch(req, url, { fallback = null } = {}) {
      const hit = api.match(req.method, url?.pathname ?? '/');
      if (hit) {
        if (await hit.handler(req, { ...url, params: hit.params })) return true;
      }
      for (const handler of chainHandlers) {
        if (await handler(req, url)) return true;
      }
      if (typeof fallback === 'function') return Boolean(await fallback(req, url));
      return false;
    },

    /** 链式处理器数量（/api/status 与测试用）。 */
    get chainSize() { return chainHandlers.length; },

    /** 注册表只读视图（测试/清单用） */
    routes() {
      return table.map((r) => ({ method: r.method, pattern: r.pattern, kind: r.kind }));
    },

    /**
     * 匹配：按注册顺序，精确/模板优先于前缀（同一 method 内）。
     * 返回 { handler, params } 或 null。
     */
    match(method, pathname) {
      const m = String(method || 'GET').toUpperCase();
      if (!METHODS.has(m)) return null;
      if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
      let path;
      try { path = normalizePath(pathname); } catch { return null; }

      // 第一轮：精确 + 模板
      for (const r of table) {
        if (r.kind === 'prefix') continue;
        if (r.method !== m && r.method !== 'ANY') continue;
        if (r.kind === 'exact') {
          if (r.pattern === path) return { handler: r.handler, params: {} };
          continue;
        }
        const hit = r.re.exec(path);
        if (hit) {
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(hit[i + 1] ?? ''); });
          return { handler: r.handler, params };
        }
      }

      // 第二轮：前缀（严格 startsWith，与原有 if 链一致）
      for (const r of table) {
        if (r.kind !== 'prefix') continue;
        if (r.method !== m && r.method !== 'ANY') continue;
        if (path.startsWith(r.pattern)) {
          return { handler: r.handler, params: { rest: path.slice(r.pattern.length) } };
        }
      }
      return null;
    },
  };

  return api;
}

export default createRouter;
