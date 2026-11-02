// DSH 连通性探测路由（0.5.44）
import { probeDsh } from '../dsh-probe.js';
import { readBrowserSessionSecret } from '../dsh-client.js';

export async function handleDshProbeRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/dsh/probe' || req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  let cfg = {};
  try { cfg = typeof d.getCfg === 'function' ? (d.getCfg() || {}) : {}; } catch { cfg = {}; }

  const dsh = cfg.dsh || {};
  let hasSecret = false;
  try { hasSecret = Boolean(readBrowserSessionSecret()); } catch { hasSecret = false; }

  const result = await probeDsh({
    baseUrl: String(dsh.baseUrl || ''),
    authToken: String(dsh.authToken || ''),
    allowRemote: Boolean(dsh.allowRemote),
    hasSessionSecret: hasSecret
  });
  sendJson({ ok: true, at: Date.now(), baseUrl: dsh.baseUrl || '', allowRemote: Boolean(dsh.allowRemote), ...result });
  return true;
}
