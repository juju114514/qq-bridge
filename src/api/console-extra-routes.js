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
import { createOverviewHandler } from './overview.js';
import { createSupervisorHandler } from '../supervisor-view.js';
import { createPeopleListHandler } from './people-list.js';
import { createSchedulerRoutes } from './scheduler-routes.js';

// 定时任务路由：引擎单例由 src/scheduler/instance.js 统一提供
// （控制台的 /api/scheduler 与 QQ 里的 /提醒 必须看到同一份任务）。
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


  // GET /api/overview —— 总览仪表盘（只读聚合，一个时间戳 + 每项自己的 at）
  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const d = resolveDeps();
    const handler = createOverviewHandler({
      sendJson,
      log: d.log,
      getMode: d.getMode,
      isDshReady: d.isDshReady,
      getOfficialStatus: d.getOfficialStatus,
      getTokenSeries: d.getTokenSeries,
      getConversations: d.getConversations,
      getQuietHours: d.getQuietHours,
      readFile: d.readFile,
      files: d.files
    });
    await handler.handle();
    return true;
  }


  // GET /api/supervisor —— 守护进程视图（存活以进程为准，历史来自日志）
  if (req.method === 'GET' && url.pathname === '/api/supervisor') {
    const d = resolveDeps();
    const handler = createSupervisorHandler({
      sendJson,
      log: d.log,
      readFile: d.readFile,
      files: d.files,
      getProcessInfo: d.getProcessInfo,
      parseRunnerEvents: d.parseRunnerEvents,
      parseWatchdogEvents: d.parseWatchdogEvents
    });
    await handler.handle();
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