// socialV2 检视类只读端点（从 bridge.js 抽出的第二片）
//
//   GET /api/socialV2/message-detail    单条消息详情（本地缓存优先，回落网关）
//   GET /api/socialV2/forward-message   合并转发（含嵌套前几条预览）
//
// 为什么先抽这两条：都只读、都已有充分的白名单/令牌校验，
// 且 forward-message 的"只能读本会话见过的 id"这条安全边界原样保留在代码里。
//
// 依赖注入；cfg / currentMode 用 getter，避免热更新后拿到旧值。

export function createSocialV2InspectHandler(deps = {}) {
  const {
    sendJson, log,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, modeAllowed,
    getCfg, getMode,
    getSocialV2State, resolveReplyInfo, formatForwardResponse, seenForwardIds, bot
  } = deps;

  const PATHS = new Set(['/api/socialV2/message-detail', '/api/socialV2/forward-message']);

  return async function handleSocialV2Inspect(req, url) {
    // 匹配交给这里；bridge 只在命中时调用（下面各分支的 return 只表示"提前结束"）
    if (!PATHS.has(url.pathname)) return;
    const cfg = getCfg();
    const currentMode = getMode();

          if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const messageId = String(url.searchParams.get('messageId') ?? '').trim();
            if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            try {
              const st = getSocialV2State(key);
              const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
              const forwardFields = found ? {
                forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
                hasForward: !!found.hasForward
              } : {};
              let info = null;
              // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
              if (found && found.messageId && String(found.messageId) !== messageId) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: String(found.messageId),
                  seq: found.seq
                };
              } else {
                info = await resolveReplyInfo(kind, id, messageId);
                if (!info && found) {
                  info = {
                    sender: String(found.sender || ''),
                    text: String(found.text || found.plain || '').slice(0, 200),
                    userId: found.userId ? String(found.userId) : null,
                    messageId: found.messageId ? String(found.messageId) : null,
                    seq: found.seq
                  };
                }
              }
              // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
              if (info && found) Object.assign(info, forwardFields);
              // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
              if (info) info.textTruncated = String(info.text ?? '').length >= 200;
              sendJson({ ok: true, key, messageId, info });
            } catch (error) {
              sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
          // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
          if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const id = String(url.searchParams.get('id') ?? '').trim();
            const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
            if (currentMode !== 'reserved2') {
              sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
              return;
            }
            if (!agentToken) {
              sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
              return;
            }
            if (!agentTokenOk(key, agentToken)) {
              sendJson({ ok: false, error: 'agent token 无效' }, 403);
              return;
            }
            const kind = keyMatch[1];
            const num = Number(keyMatch[2]);
            if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
              sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
              return;
            }
            if (!v2ToolEnabled('getForwardMsg')) {
              sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
              return;
            }
            // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
            const st = getSocialV2State(key);
            const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
            const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
            const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
            if (!seenInRecent && !seenInUnread && !seenInMemory) {
              sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
              return;
            }
            try {
              const data = await bot.raw('get_forward_msg', { id });
              const formatted = formatForwardResponse(data);
              const remember = (fid) => {
                if (!fid) return;
                let set = seenForwardIds.get(key);
                if (!set) {
                  set = new Set();
                  seenForwardIds.set(key, set);
                }
                set.add(fid);
                if (set.size > 1000) {
                  for (const old of set) {
                    set.delete(old);
                    if (set.size <= 1000) break;
                  }
                }
              };
              // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
              for (const m of formatted.messages || []) {
                for (const fid of m.nestedForwardIds || []) remember(fid);
              }
              // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
              const nestedPreviews = [];
              const nestedIds = [];
              const seenNested = new Set();
              for (const m of formatted.messages || []) {
                for (const fid of m.nestedForwardIds || []) {
                  if (!seenNested.has(fid) && nestedIds.length < 5) {
                    seenNested.add(fid);
                    nestedIds.push(fid);
                  }
                }
              }
              for (const fid of nestedIds) {
                try {
                  const ndata = await bot.raw('get_forward_msg', { id: fid });
                  const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                  for (const nm of nfmt.messages || []) {
                    for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                  }
                  nestedPreviews.push({ id: fid, ...nfmt });
                } catch (error) {
                  log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                  nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
                }
              }
              sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
            } catch (error) {
              log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
              sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
  };
}
