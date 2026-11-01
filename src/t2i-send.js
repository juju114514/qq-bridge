// 长文本转图：把「判断 + 渲染 + 出段」收在一处（0.4.118）
//
// 抽出来的理由：bridge.js 已到体积上限，这里逻辑完整且可单测。
import { renderTextImage, shouldRenderAsImage } from './t2i.js';

/**
 * @param {string} text 原始回复文本
 * @param {{enabled?:boolean, threshold?:number, width?:number, title?:string, footer?:string}} cfg
 * @param {(m:string)=>void} log
 * @returns {Promise<{type:'image', data:{file:string}}|null>} 成功返回图片段，否则 null
 */
export async function makeTextImageSegment(text, cfg = {}, log = () => {}, paths = {}) {
  if (cfg.enabled !== true) return null;
  const raw = String(text ?? '');
  if (/\[CQ:/.test(raw)) return null;                       // 带 CQ 码的内容不能简单转图
  if (!shouldRenderAsImage(raw, { threshold: cfg.threshold })) return null;
  const img = await renderTextImage(raw, {
    width: cfg.width,
    title: String(cfg.title || ''),
    footer: String(cfg.footer || 'qq-bridge'),
    profileDir: paths.profileDir || '',
    workRoot: paths.workRoot || '',
    log
  });
  if (!img) return null;
  log(`[t2i] 长文本已转图（${Math.round(img.buffer.length / 1024)}KB）`);
  return { type: 'image', data: { file: 'base64://' + img.buffer.toString('base64') } };
}
