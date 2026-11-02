// 网关状态 / 手动启动路由（0.4.131）
import { getGatewayStatus, startGateway } from '../gateway-control.js';

export async function handleGatewayControlRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/gateway/control')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});

  // GET /api/gateway/control → 状态
  if (req.method === 'GET') {
    const status = await getGatewayStatus(d.gatewayPorts ? { ports: d.gatewayPorts } : {});
    sendJson({ ok: true, at: Date.now(), ...status });
    return true;
  }

  // POST /api/gateway/control/start → 用户点「启动网关」
  if (req.method === 'POST' && url.pathname === '/api/gateway/control/start') {
    const result = await startGateway(d.gatewayPorts ? { ports: d.gatewayPorts } : {});
    d.log?.(`[gateway] 用户手动启动（来源：控制台）→ ${result.ok ? (result.started ? '已启动' : '本来就在跑') : '失败：' + result.error}`);
    sendJson({ ok: result.ok, at: Date.now(), ...result }, result.ok ? 200 : 500);
    return true;
  }

  sendJson({ ok: false, error: '未知的网关控制请求' }, 404);
  return true;
}
