// socialV2 唤醒提示（从 bridge.js 抽出的第八片）
//
//   GET /api/socialV2/prompt?key=...
//
// 这是 AI 每次醒来拿到的"上下文包"：身份、角色、工具开关、唤醒建议、
// 记忆、参与度、黑话、表情、语音库。依赖面很大（30+ 个符号），所以：
//   · 模块级可变状态（selfDisplayName / selfUserId / slangEntries / stickerEntries）
//     一律用 **getter** 传入，避免拿到启动时的旧快照
//   · cfg 与 currentMode 同样用 getter
//
// 黄金快照脚本 scripts/snapshot-prompt.mjs 就是用它做"行为不变"的证明。

export function createSocialV2PromptHandler(deps = {}) {
  const {
    sendJson,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    getCfg, getMode, getSocialV2State,
    getSelfDisplayName, getSelfUserId, selfIdentityTextV2,
    readRoleState, currentRoleHintV2, currentRoleHint,
    replyTimingV2, computeWakeSafetyV2, formatMemoryV2, formatParticipationV2,
    confirmedSlangListV2, getSlangEntries, buildSlangContext,
    getStickerEntries, buildStickerContext, buildStickerStrategyHint,
    stickerEnabled, stickerCuratorEnabled, stickerScopeOf, stickerPending,
    renderPendingHint, stickerHintFor, buildCuratorPrompt,
    syncStickerLibrary, voiceLibrary, voiceCfg
  } = deps;

  return async function handleSocialV2Prompt(req, url) {
    const cfg = getCfg();
    const currentMode = getMode();
    // 原代码直接引用这些模块级变量；抽出来后统一在顶部取一次
    const selfDisplayName = getSelfDisplayName();
    const selfUserId = getSelfUserId();
    const slangEntries = getSlangEntries();
    const stickerEntries = getStickerEntries();

          if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
            const st = getSocialV2State(key);
            // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
            if (cfg.socialV2?.sticker?.enabled !== false) {
              try { await syncStickerLibrary(false); } catch {}
            }
            const roleState = readRoleState();
            const toolMap = {
              getPrompt: 'qq_get_prompt',
              getUnread: 'qq_get_unread_messages',
              getRecent: 'qq_get_recent_messages',
              socialState: 'qq_social_state',
              sendGroup: 'qq_send_group_message',
              sendPrivate: 'qq_send_private_message',
              reply: 'qq_reply',
              sendBurst: 'qq_send_burst',
              sendMessage: 'qq_send_message',
              waitMessages: 'qq_wait_for_messages',
              feedback: 'qq_report_feedback',
              getMyRecent: 'qq_get_my_recent_messages',
              getMessageDetail: 'qq_get_message_detail',
              getActiveMembers: 'qq_get_active_members',
              setWakeConfig: 'qq_set_wake_config',
              markRead: 'qq_mark_read',
              memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
              slangQuery: 'qq_slang_query',
              slangSubmit: 'qq_slang_submit',
              getImages: 'qq_get_message_images',
              getForwardMsg: 'qq_get_forward_msg',
              sendPoke: 'qq_send_poke',
              listStickers: 'qq_list_stickers',
              getStickerImage: 'qq_get_sticker_image',
              sendSticker: 'qq_send_sticker',
              setStickerRemark: 'qq_set_sticker_remark',
              stickerNote: 'qq_sticker_note',
              collectSticker: 'qq_collect_sticker',
              getSelfImage: 'qq_get_self_image',
              sendVoice: 'qq_send_voice / qq_list_voices'
            };
            const tools = cfg.socialV2?.tools ?? {};
            const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
            const enabledTools = [];
            for (const [flag, name] of Object.entries(toolMap)) {
              if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
            }
            sendJson({
              ok: true,
              key,
              time: new Date().toISOString(),
              // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
              self: {
                nickname: selfDisplayName || null,
                userId: selfUserId || null,
                line: selfIdentityTextV2().trim() || null
              },
              role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
              recommended: cfg.socialV2?.provideRecommendations === false ? null : {
                wake: cfg.socialV2?.wake ?? {},
                send: cfg.socialV2?.send ?? {},
                wait: cfg.socialV2?.wait ?? {},
                proactive: cfg.socialV2?.proactive ?? {}
              },
              enabledTools,
              replyTiming: replyTimingV2(st),
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              currentWakeConfig: st.wakeConfig,
              wakeSafety: computeWakeSafetyV2(st.wakeConfig),
              memory: formatMemoryV2(st),
    // 人物库：只注入"当前会话里最近说话的人"的关系与笔记（陌生人/无记录则整段不出现）
    ...(() => {
      try {
        const hint = typeof deps.peopleHintFor === 'function' ? String(deps.peopleHintFor(key) ?? '').trim() : '';
        return hint ? { people: { hint } } : {};
      } catch { return {}; }
    })(),
              participation: formatParticipationV2(st),
              slang: {
                enabled: cfg.slang?.enabled !== false,
                entries: confirmedSlangListV2(),
                block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
              },
              stickers: {
                enabled: cfg.socialV2?.sticker?.enabled !== false,
                total: stickerEntries.length,
                context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
                strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : '',
                // 待判表情：只在本会话 scope 内取，且 curator 关闭时恒为空
                pending: (() => {
                  try {
                    if (!stickerCuratorEnabled(cfg)) return '';
                    const scope = stickerScopeOf(key);
                    const items = stickerPending.take(scope, { clear: false });
                    return renderPendingHint(items, { style: cfg?.socialV2?.sticker?.curator?.pendingStyle || 'hard' });
                  } catch { return ''; }
                })(),
                // 只影响"发不发/发哪张"，且严格按会话 scope 取（群聊的绝不进私聊）
                hint: stickerHintFor(key, cfg),
                // 指令片段：告诉模型"看到表情先判断含义，有用才收、闲聊可主动发"
                guidance: stickerCuratorEnabled(cfg) ? buildCuratorPrompt(cfg?.socialV2?.sticker?.curator ?? {}) : ''
              },
              // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
              voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
                enabled: true,
                total: voiceLibrary().length,
                names: voiceLibrary().slice(0, 12).map((v) => v.name),
                maxSeconds: voiceCfg().maxSeconds,
                hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
              }
            });
            return;
          }
  };
}
