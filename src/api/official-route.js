// GET /api/official —— 官方通道接入闸门（只读：能不能接、还差什么）。
//
// 单独成文件的原因：console-extra-routes 有行数棘轮，官方通道这块逻辑还要继续长
// （配额、主动消息窗口…），留在调用侧会把那个文件撑爆。
import { officialGate } from '../official/gate.js';

export function handleOfficialRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/official') return false;
  if (req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const cfg = (typeof d.getCfg === 'function' ? d.getCfg() : {}) || {};

  // 「探针通过」= 有标记文件（跑过 official-probe）；运行时已连接则由 gate 自己接受
  let probePassed = false;
  try {
    const probeFile = d.files && d.files.probe ? d.files.probe : '';
    if (probeFile && typeof d.readFile === 'function') {
      probePassed = String(d.readFile(probeFile) || '').includes('"at"');
    }
  } catch { probePassed = false; }

  const runtime = typeof d.getOfficialRuntime === 'function' ? (d.getOfficialRuntime() || {}) : {};
  const gate = officialGate({
    cfg: cfg.official,
    probePassed,
    transportReady: runtime.ready === true,
    lastError: String(runtime.lastError || '')
  });
  sendJson({ ok: true, at: Date.now(), ...gate, runtime });
  return true;
}
