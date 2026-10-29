// 控制台 → AI 后台提醒（从 bridge.js 抽出的第三片）
//
//   POST /api/console/notify-ai
//   把操作者在控制台写的一句话，作为「后台提醒」投给该会话的 DSH agent。
//
// 抽取要点：
//   · dshReady 是模块级 let（会变），必须用 getter 传，不能传值
//   · social.silentTurns 是共享 Map，传引用（副作用要可见）
//   · 会话令牌那一行仅在 reserved2 下拼接（原有行为，原样保留）

export function createConsoleNotifyHandler(deps = {}) {
  const {
    sendJson, readBody, log,
    modeAllowed, allowed,
    getCfg, getMode, getState, getDshReady,
    readRoleState, getSocialV2State,
    ensureSession, social, deliverPrompt, appendActivity
  } = deps;

  return async function handleConsoleNotifyAi(req, url) {
    const cfg = getCfg();
    const currentMode = getMode();
    const state = getState();
    const dshReady = getDshReady();

          if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const message = String(body.message ?? '').trim();
            if (!key || !message) {
              sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
              return;
            }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) {
              sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
              return;
            }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            if (!Number.isFinite(id) || id <= 0) {
              sendJson({ ok: false, error: 'id 无效' }, 400);
              return;
            }
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
              return;
            }
            if (!state.sessions[key] && !allowed(kind, id, cfg)) {
              sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
              return;
            }
            if (!dshReady) {
              sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
              return;
            }
            const isV2 = currentMode === 'reserved2';
            const roleState = readRoleState();
            const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
            // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
            let tokenLine = '';
            if (isV2) {
              const stV2 = getSocialV2State(key);
              tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
            }
            const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
            let sessionId = null;
            let popSilent = null;
            try {
              sessionId = await ensureSession(key);
              const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              const arr = social.silentTurns.get(sessionId) ?? [];
              social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
              popSilent = () => {
                const list = social.silentTurns.get(sessionId) ?? [];
                const next = list.filter((x) => x.id !== silentId);
                if (next.length > 0) social.silentTurns.set(sessionId, next);
                else social.silentTurns.delete(sessionId);
              };
              const result = await deliverPrompt(key, promptText, { silent: true });
              if (result.ok) {
                log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
                appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
                sendJson({ ok: true, key, sessionId });
              } else {
                popSilent();
                sendJson({ ok: false, error: result.error || '投递失败' }, 500);
              }
            } catch (error) {
              if (popSilent) popSilent();
              sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
            }
            return;
          }
  };
}
