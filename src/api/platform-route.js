// 平台能力路由（0.5.43）
import { detectCapabilities, describeCapabilities } from '../platform-capabilities.js';

export async function handlePlatformRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/platform' || req.method !== 'GET') return false;

  const caps = detectCapabilities();
  sendJson({ ok: true, at: Date.now(), ...caps, summary: describeCapabilities(caps) });
  return true;
}
