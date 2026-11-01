// 官方扫码绑定路由（0.4.114）
//
// POST /api/official/bind/start            → 创建绑定任务，返回二维码内容
// POST /api/official/bind/poll  {taskId}   → 查询状态；完成时返回 appid + secret（只回这一次）
// POST /api/official/bind/apply {appid, secret, sandbox?} → 写进配置（重启后生效）
import fs from 'node:fs';
import path from 'node:path';

export async function handleOfficialBindRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || !url.pathname.startsWith('/api/official/bind/')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const session = d.officialBind;
  if (!session) { sendJson({ ok: false, error: '绑定模块未就绪' }, 500); return true; }

  if (url.pathname === '/api/official/bind/start' && req.method === 'POST') {
    try {
      const r = await session.start();
      sendJson({ ok: true, ...r, note: '用手机 QQ 扫这个二维码；扫完这里会自动完成' });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) });
    }
    return true;
  }

  if (url.pathname === '/api/official/bind/poll' && req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    try {
      const r = await session.poll(body.taskId);
      sendJson({ ok: r.status !== 'unknown', ...r });
    } catch (error) {
      sendJson({ ok: false, status: 'error', error: String(error?.message ?? error) });
    }
    return true;
  }

  if (url.pathname === '/api/official/bind/apply' && req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    const appid = String(body.appid || '').trim();
    const secret = String(body.secret || '').trim();
    if (!appid || !secret) { sendJson({ ok: false, error: 'appid / secret 不完整' }, 400); return true; }
    const configFile = d.files?.config || '';
    if (!configFile) { sendJson({ ok: false, error: '找不到 config.json' }, 500); return true; }
    try {
      const raw = fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      cfg.official = {
        ...(cfg.official && typeof cfg.official === 'object' ? cfg.official : {}),
        enabled: body.enabled !== false,
        appid,
        secret,
        sandbox: body.sandbox === true
      };
      const tmp = `${configFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      // guard-allow: renameSync 写的是 config.json，沿用全局 tmp+rename 约定（与 whitelist/security 等一致）
      fs.renameSync(tmp, configFile);
      sendJson({
        ok: true,
        appid,
        note: '已写入 config.json。**重启桥接后生效**（排错程序 → 停止 → 一键拉起）'
      });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '未知的绑定路由' }, 404);
  return true;
}
