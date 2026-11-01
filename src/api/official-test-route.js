// POST /api/official/test-markdown —— 发一条 markdown 测试消息（0.4.115）
//
// 用途：确认官方 markdown 在当前机器人/群里到底渲染成什么样。
// openid 留空时用「最近一条入站」的会话（state/official-inbound.json）。
export async function handleOfficialTestRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/official/test-markdown') return false;
  if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  if (typeof d.officialTestSend !== 'function') { sendJson({ ok: false, error: '官方通道未启用' }, 400); return true; }

  const body = (await ctx.readBody?.()) || {};
  const markdown = String(body.markdown || '').trim() || DEFAULT_TEST_MARKDOWN;
  try {
    const r = await d.officialTestSend({ kind: body.kind, openid: body.openid, markdown });
    sendJson({ ok: true, ...r, note: '已发送；去那个会话里看渲染效果' });
  } catch (error) {
    const code = error?.code;
    sendJson({ ok: false, error: String(error?.message ?? error), code });
  }
  return true;
}

/** 默认测试内容：把官方支持的语法都覆盖一遍 */
export const DEFAULT_TEST_MARKDOWN = [
  '## markdown 测试',
  '',
  '这是 **加粗**、__下划线__、_斜体_、~~删除线~~。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用行',
  '',
  '***',
  '',
  '[链接示例](https://bot.q.qq.com)'
].join('\n');
