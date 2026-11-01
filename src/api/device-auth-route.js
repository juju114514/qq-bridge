// 设备配对 + 签名（0.4.107）
//
// POST /api/auth/pairing-code   （需控制台令牌）→ 生成 6 位配对码，60 秒有效
// POST /api/auth/pair           {code, name}   → 领取 deviceId + deviceSecret（只回这一次）
// GET  /api/auth/devices        （需控制台令牌）→ 设备列表（不含 secret）
// POST /api/auth/devices/revoke {id}           （需控制台令牌）→ 吊销
// GET  /api/auth/mode           → {mode}  （off | warn | enforce）
// POST /api/auth/mode           {mode}         （需控制台令牌）
//
// 校验签名的那段在 bridge 的请求入口里（enforce 模式才拦）。
export async function handleDeviceAuthRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || !url.pathname.startsWith('/api/auth/')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const devices = d.deviceStore;
  const codes = d.pairingCodes;
  if (!devices || !codes) { sendJson({ ok: false, error: '设备模块未就绪' }, 500); return true; }

  if (url.pathname === '/api/auth/mode') {
    if (req.method === 'GET') { sendJson({ ok: true, mode: String(d.getDeviceAuthMode?.() || 'off') }); return true; }
    if (req.method === 'POST') {
      const body = (await ctx.readBody?.()) || {};
      const mode = String(body.mode || '');
      if (!['off', 'warn', 'enforce'].includes(mode)) { sendJson({ ok: false, error: 'mode 只能是 off/warn/enforce' }, 400); return true; }
      d.setDeviceAuthMode?.(mode);
      sendJson({ ok: true, mode });
      return true;
    }
    sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
    return true;
  }

  if (url.pathname === '/api/auth/pairing-code' && req.method === 'POST') {
    const issued = codes.issue();
    sendJson({ ok: true, code: issued.code, expiresAt: issued.expiresAt, note: '60 秒内有效；在手机页输入这个码' });
    return true;
  }

  if (url.pathname === '/api/auth/pair' && req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    const r = codes.consume(body.code);
    if (!r.ok) { sendJson({ ok: false, error: r.error }, 400); return true; }
    const dev = devices.add(body.name || '手机');
    sendJson({ ok: true, deviceId: dev.id, deviceSecret: dev.secret, name: dev.name, note: 'secret 只回这一次，请存在手机安全存储里' });
    return true;
  }

  if (url.pathname === '/api/auth/devices') {
    if (req.method === 'GET') { sendJson({ ok: true, devices: devices.list() }); return true; }
    if (req.method === 'POST') {
      const body = (await ctx.readBody?.()) || {};
      if (body.action !== 'revoke') { sendJson({ ok: false, error: "只支持 action:'revoke'" }, 400); return true; }
      const ok = devices.revoke(String(body.id || ''));
      sendJson({ ok, error: ok ? undefined : '没找到这个设备' });
      return true;
    }
    sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
    return true;
  }

  sendJson({ ok: false, error: '未知的 auth 路由' }, 404);
  return true;
}
