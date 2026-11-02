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
import { handleOfficialRoute } from './official-route.js';
import { handleQzoneEndpoints } from './qzone-endpoints.js';
import { handleSessionResetRoute } from './session-reset-route.js';
import { handleSessionBackupsRoute } from './session-backups-route.js';
import { handleRoleImageRoute } from './role-image-route.js';
import { handleRoleMapRoute } from './role-map-route.js';
import { handleEnvironmentRoute } from './environment-route.js';
import { handleGatewayAccountsRoute } from './gateway-accounts-route.js';
import { handleDeviceAuthRoute } from './device-auth-route.js';
import { handleOfficialBindRoute } from './official-bind-route.js';
import { handleOfficialTestRoute } from './official-test-route.js';
import { handleUpdateRoute } from './update-route.js';
import { handleT2iPreviewRoute } from './t2i-route.js';
import { handleSetupStatusRoute } from './setup-route.js';
import { handleOfficialHealthRoute } from './official-health-route.js';
import { handleGatewayControlRoute } from './gateway-control-route.js';
import { handleMusicAuthRoute } from './music-auth-route.js';
import { handleMusicQqRoute } from './music-qq-route.js';
import { handleContextUsageRoute } from './context-usage-route.js';
import { handlePlatformRoute } from './platform-route.js';
import { handleDshProbeRoute } from './dsh-probe-route.js';
import { handleReportRoute } from './report-route.js';
import { createPeopleListHandler } from './people-list.js';
import { createSchedulerRoutes } from './scheduler-routes.js';

// 定时任务路由：引擎单例由 src/scheduler/instance.js 统一提供
// （控制台的 /api/scheduler 与 QQ 里的 /提醒 必须看到同一份任务）。
let schedulerRoutes = null;

export async function handleExtraRoutes(ctx = {}) {
  const { req, url, res, sendJson, readBody } = ctx;
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

  // GET /api/official —— 官方通道接入闸门（实现见 official-route.js）
  if (await handleOfficialRoute({ req, url, sendJson, deps: resolveDeps })) return true;

  // GET /api/report —— 运行报告（只读；?format=md 直接拿 Markdown）
  if (await handleReportRoute({ req, url, sendJson, deps: resolveDeps })) return true;



  // 空间域（草稿 / 上传 / 删除）—— 实现见 qzone-endpoints.js
  if (await handleQzoneEndpoints({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // POST /api/sessions/reset —— 一键重置会话（可先备份）
  if (await handleSessionResetRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // GET/DELETE /api/session-backups —— 会话备份列表 / 详情 / 删除
  if (await handleSessionBackupsRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // GET/POST/DELETE /api/roles/image —— 人物卡外观照片
  if (await handleRoleImageRoute({ req, url, sendJson, readBody: ctx.readBody, sendRaw: ctx.sendRaw, deps: resolveDeps })) return true;

  // GET/POST /api/roles/map —— 每个会话的角色分配与状态
  if (await handleRoleMapRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // GET/POST /api/environment —— 时间/天气
  if (await handleEnvironmentRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // GET/POST /api/gateway/accounts —— 网关多账号
  if (await handleGatewayAccountsRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  if (await handlePlatformRoute({ req, url, sendJson })) return true;
  if (await handleDshProbeRoute({ req, url, sendJson, deps: resolveDeps })) return true;
  if (await handleContextUsageRoute({ req, url, sendJson, deps: resolveDeps })) return true;   // 上下文用量 0.4.141
  // QQ 音乐点歌（0.4.136）
  if (await handleMusicQqRoute({ req, url, sendJson, readBody, deps: resolveDeps })) return true;

  // 音乐账号登录（0.4.135）
  if (await handleMusicAuthRoute({ req, url, sendJson, readBody, deps: resolveDeps })) return true;

  // 网关状态 / 手动启动（0.4.131）
  if (await handleGatewayControlRoute({ req, url, sendJson, deps: resolveDeps })) return true;

  // 官方通道存活（0.4.130）
  if (await handleOfficialHealthRoute({ req, url, sendJson, deps: resolveDeps })) return true;

  // 新手向导状态（0.4.124）
  if (await handleSetupStatusRoute({ req, url, sendJson, deps: resolveDeps })) return true;

  // 长文本转图预览（0.4.118）
  if (await handleT2iPreviewRoute({ req, url, res, sendJson, deps: resolveDeps })) return true;

  // 版本更新检查（0.4.114）
  if (await handleUpdateRoute({ req, url, sendJson, deps: resolveDeps })) return true;

  // 官方 markdown 测试发送（0.4.115）
  if (await handleOfficialTestRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // 官方机器人扫码绑定（0.4.114）
  if (await handleOfficialBindRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

  // GET /api/console/addresses —— 手机能用哪些地址连（0.4.111）
  if (req.method === 'GET' && url.pathname === '/api/console/addresses') {
    let hosts = [];
    try {
      const d = typeof resolveDeps === 'function' ? (resolveDeps() || {}) : (resolveDeps || {});
      hosts = typeof d.consoleAddresses === 'function' ? d.consoleAddresses() : [];
    } catch { hosts = []; }
    sendJson({ ok: true, hosts });
    return true;
  }

  // 设备配对 / 签名（0.4.107）
  if (await handleDeviceAuthRoute({ req, url, sendJson, readBody: ctx.readBody, deps: resolveDeps })) return true;

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