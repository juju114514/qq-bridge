// 官方通道存活快照（0.4.130）
//
// 为什么单独一条：连接「显示 connected 但早就收不到消息」是真实发生过的故障，
// 控制台需要一个能区分「连着」和「还活着」的信号。
import { describeLiveness } from '../official-health.js';

export async function handleOfficialHealthRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/official/health' || req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  let snap = null;
  try { snap = d.getOfficialHealth ? d.getOfficialHealth() : null; } catch { snap = null; }
  const verdict = describeLiveness(snap);
  sendJson({ ok: true, at: Date.now(), ...verdict, liveness: snap });
  return true;
}
