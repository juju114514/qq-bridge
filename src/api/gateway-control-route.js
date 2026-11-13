// 网关状态 / 手动启动路由（0.4.131）
import { getGatewayStatus, startGateway, stopGateway, restartGateway, gatewayHealthPayload } from '../gateway-control.js';

export async function handleGatewayControlRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/gateway/')) return false;   // control 与 health 都归这里

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});

  // GET /api/gateway/health → 顶栏胶囊用（0.4.132）
  if (req.method === 'GET' && url.pathname === '/api/gateway/health') {
    const payload = await gatewayHealthPayload(d);
    sendJson({ ok: true, at: Date.now(), ...payload });
    return true;
  }

  // GET /api/gateway/control → 状态
  if (req.method === 'GET') {
    const status = await getGatewayStatus(d.gatewayPorts ? { ports: d.gatewayPorts } : {});
    sendJson({ ok: true, at: Date.now(), ...status });
    return true;
  }

  // POST /api/gateway/control/stop → 停掉所有 SnowLuma 进程（0.4.142）
  if (req.method === 'POST' && url.pathname === '/api/gateway/control/stop') {
    const r = await stopGateway();
    (d.log || (() => {}))(`[gateway] 用户手动停止：清理 ${r.stopped.length} 个进程${r.remaining.length ? `，仍有 ${r.remaining.length} 个没退出` : ''}`);
    sendJson({ ok: r.remaining.length === 0, stopped: r.stopped, remaining: r.remaining, at: Date.now() });
    return true;
  }

  // POST /api/gateway/control/start → 用户点「启动网关」
  if (req.method === 'POST' && url.pathname === '/api/gateway/control/start') {
    const result = await startGateway(d.gatewayPorts ? { ports: d.gatewayPorts } : {});
    d.log?.(`[gateway] 用户手动启动（来源：控制台）→ ${result.ok ? (result.started ? '已启动' : '本来就在跑') : '失败：' + result.error}`);
    sendJson({ ok: result.ok, at: Date.now(), ...result }, result.ok ? 200 : 500);
    return true;
  }
  // POST /api/gateway/control/restart → 完全重启（实现见 gateway-control.restartGateway）
  if (req.method === 'POST' && url.pathname === '/api/gateway/control/restart') {
    const result = await restartGateway({ ...(d.gatewayPorts ? { ports: d.gatewayPorts } : {}), log: d.log });
    sendJson(result, result.ok ? 200 : 500);
    return true;
  }

  sendJson({ ok: false, error: '未知的网关控制请求' }, 404);
  return true;
}
