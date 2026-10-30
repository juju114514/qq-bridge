// 控制台的"零散路由"：不进 bridge.js 的单端点。
//
// 为什么要这个文件：`test-domains.mjs` 有一条棘轮 —— bridge.js 里的内联路由只许减少
// （当前预算 55）。每加一个端点就往 bridge 里塞 6 行，棘轮很快会被顶爆。
// 所以新增的**简单只读端点**一律走这里：bridge 只保留一次调用。
//
// 约定：
//   · handleExtraRoutes(ctx) 返回 true = 已处理（调用方 return）
//   · ctx = { req, url, sendJson, deps }
//   · deps 由 bridge 在调用点组装（这样模块不依赖 bridge 的闭包，可单测）

import { createDiagnosticsHandler } from './console-diagnostics.js';

export async function handleExtraRoutes(ctx = {}) {
  const { req, url, sendJson, deps = {} } = ctx;
  if (!url || !req) return false;

  // GET /api/diagnostics —— 诊断与健康（只读）
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    const handler = createDiagnosticsHandler(deps);
    await handler.handle({ sendJson });
    return true;
  }

  return false;
}