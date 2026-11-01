import path from 'node:path';
// GET /api/t2i/preview?text=... —— 把一段文本渲染成卡片图（0.4.118）
//
// 用途：调模板/字号时不用真往群里发；也方便验证「这台机器到底能不能转图」。
import { renderTextImage, shouldRenderAsImage } from '../t2i.js';
import { findBrowser } from '../browser-detect.js';

export async function handleT2iPreviewRoute(ctx = {}) {
  const { req, url } = ctx;
  if (!req || !url || url.pathname !== '/api/t2i/preview') return false;
  if (req.method !== 'GET') { ctx.sendJson({ ok: false, error: '只支持 GET' }, 405); return true; }

  const browser = findBrowser();
  if (!browser) {
    ctx.sendJson({ ok: false, error: '这台机器上没有 Edge/Chrome，转图不可用' }, 400);
    return true;
  }
  const text = String(url.searchParams.get('text') || '').trim()
    || '这是一段示例文本。\n\n长回复会渲染成这样的卡片：\n1. 保留换行\n2. 中文排版不糊\n3. 手机上看清楚';
  const width = Number(url.searchParams.get('width')) || 640;
  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const log = typeof d.log === 'function' ? d.log : () => {};
  const img = await renderTextImage(text, {
    width, title: String(url.searchParams.get('title') || ''), footer: 'qq-bridge · 预览', log,
    profileDir: path.join(d.stateDir || '', 't2i-profile'),
    workRoot: path.join(d.stateDir || '', 't2i-tmp')
  });
  if (!img) { ctx.sendJson({ ok: false, error: '渲染失败（浏览器超时或崩溃）' }, 500); return true; }

  ctx.res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  ctx.res.end(img.buffer);
  return true;
}
