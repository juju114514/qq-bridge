// GET/POST /api/qzone/draft —— AI 写空间（0.4.77）
//
// 设计见 src/qzone-draft.js 头注释：让 agent 在 owner 私聊里写，我们再把它那句话收回来当草稿。
// 本文件只做 HTTP 适配 + 触发；**不自动发布**，发布仍走 /api/socialV2/qzone 且必须人点。
import { readDraft, writeDraft, emptyDraft, suggestStickers } from '../qzone-draft.js';
import { STYLE_CATALOG, buildStylePrompt, resolveStyles, describeStyles, MAX_STYLES } from '../qzone-styles.js';

export async function handleQzoneDraftRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/qzone/draft') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const file = d.files?.qzoneDraft || '';

  if (req.method === 'GET') {
    // 配图建议：只给 1~2 个（防止一次配 9 张图显得像广告）
    let stickerSuggestions = [];
    try {
      const pick = typeof d.getStickerEntries === 'function' ? d.getStickerEntries() : [];
      stickerSuggestions = suggestStickers(pick, { max: 2 });
    } catch { stickerSuggestions = []; }
    sendJson({ ok: true, draft: readDraft(file), styles: STYLE_CATALOG, maxStyles: MAX_STYLES, stickerSuggestions });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson({ ok: false, error: '只支持 GET / POST' }, 405);
    return true;
  }

  const body = (await (ctx.readBody || d.readBody)?.()) || {};
  const action = String(body.action || 'request');

  if (action === 'clear') {
    writeDraft(file, emptyDraft());
    sendJson({ ok: true, note: '已清空草稿' });
    return true;
  }

  if (action !== 'request') {
    sendJson({ ok: false, error: 'action 只能是 request / clear' }, 400);
    return true;
  }

  const cfg = (typeof d.getCfg === 'function' ? d.getCfg() : {}) || {};
  const ownerKey = `private:${String(cfg.ownerQQ || '').trim()}`;
  if (!String(cfg.ownerQQ || '').trim()) {
    sendJson({ ok: false, error: '没配 ownerQQ，无法让 AI 起草（控制台「访问与安全」里填）' }, 400);
    return true;
  }
  if (typeof d.deliverPrompt !== 'function') {
    sendJson({ ok: false, error: '当前版本不支持投递（deliverPrompt 未注入）' }, 501);
    return true;
  }

  // styles 可以是数组（多选）或字符串；空 → 让它自己定
  const styles = resolveStyles(body.styles || body.style || 'auto');
  const prompt = buildStylePrompt({
    styles,
    hint: String(body.hint || ''),
    recent: String(body.recent || '')
  });

  // 先落 pending，再投递：投递失败时把状态改回 error（避免"永远 pending"）
  writeDraft(file, { status: 'pending', text: '', style: styles[0], styles, candidates: [], at: Date.now(), error: '' });
  try {
    const r = await d.deliverPrompt(ownerKey, prompt, { source: 'qzone-draft' });
    if (r && r.ok === false) {
      writeDraft(file, { status: 'error', text: '', style: styles[0], styles, candidates: [], at: Date.now(), error: String(r.error || '投递失败') });
      sendJson({ ok: false, error: String(r.error || '投递失败') }, 502);
      return true;
    }
  } catch (error) {
    writeDraft(file, { status: 'error', text: '', style: styles[0], styles, candidates: [], at: Date.now(), error: String(error?.message ?? error) });
    sendJson({ ok: false, error: `投递失败：${error?.message ?? error}` }, 502);
    return true;
  }

  sendJson({
    ok: true,
    note: `已请它写「${describeStyles(styles)}」；几秒后回来点「取草稿」`,
    styles,
    hint: '如果 10 秒还没出来，看你的 QQ 私聊里它有没有回（草稿就是那条回复）'
  });
  return true;
}
