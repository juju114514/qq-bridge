// 控制台的"零散路由"：不进 bridge.js 的单端点。
//
// 为什么要这个文件：`test-domains.mjs` 有一条棘轮 —— bridge.js 里的内联路由只许减少
// （预算 55）。每加一个端点就往 bridge 里塞 6 行，棘轮很快会被顶爆。
// 所以新增的**简单端点**一律走这里：bridge 只保留一次调用。
//
// 约定：
//   · handleExtraRoutes(ctx) 返回 true = 已处理（调用方 return）
//   · ctx = { req, url, sendJson, deps }
//   · deps 可以是对象，**也可以是函数**（惰性）：bridge 侧有些访问器在别的闭包里，
//     每个请求都求值会在测试环境（VM 注入不全）里直接 ReferenceError —— 真实踩过。

import { createDiagnosticsHandler } from './console-diagnostics.js';
import { createPeopleListHandler } from './people-list.js';
import { createSchedulerRoutes } from './scheduler-routes.js';

// 定时任务引擎内部持有状态机 + 定时器，必须**单例**：每请求新建会重复挂定时器。
let schedulerRoutes = null;

export async function handleExtraRoutes(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !req) return false;
  const resolveDeps = () => (typeof ctx.deps === 'function' ? ctx.deps() : (ctx.deps || {}));

  // /api/scheduler* —— 定时任务（引擎在 src/scheduler/，从同源分叉移植）
  if (url.pathname === '/api/scheduler' || url.pathname.startsWith('/api/scheduler/')) {
    schedulerRoutes ??= createSchedulerRoutes(resolveDeps());
    await schedulerRoutes.handle({ req, url, sendJson, readBody: ctx.readBody });
    return true;
  }

  // GET /api/diagnostics —— 诊断与健康（只读）
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    const handler = createDiagnosticsHandler(resolveDeps());
    await handler.handle({ sendJson });
    return true;
  }

  // GET /api/socialV2/people —— 人物库列表（只读）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/people') {
    const handler = createPeopleListHandler(resolveDeps());
    await handler.handle({ url, sendJson });
    return true;
  }

  return false;
}