// 控制台自管与一次性操作：
//   POST /api/console/token   改/生成控制台访问令牌
//   POST /api/test-send       测试发送（强制白名单 + 敏感词 + 模式校验）
//   POST /api/authorize/read  旧只读工具的会话授权（不能空 token 放行！）
//
// 为什么放一起：都属于"管理员手动触发的运维动作"，依赖少、逻辑短，
// 从 startConsoleServer 里搬出来能直接减少 if 链长度。
//
// 依赖两类：baseDeps（启动给一次）+ ctx（每请求的 sendJson / readBody）。

export function createConsoleOpsHandlers(baseDeps = {}) {
  const {
    log = () => {},
    crypto, path, readConfigObject, atomicWriteJson, atomicWriteText,
    getCfg, getCurrentMode, setConsoleToken,
    SENSITIVE_RE, allowed, modeAllowed, escapeCqText, redactKnownTokensOnly,
    agentTokenOk, getBot, text
  } = baseDeps;

  /** POST /api/console/token —— 留空则生成随机令牌 */
  async function handleToken(ctx = {}) {
    const { readBody, sendJson } = ctx;
    const body = await readBody();
    let newToken = String(body.token ?? '').trim();
    const generated = !newToken;
    if (generated) newToken = crypto.randomBytes(24).toString('hex');
    if (newToken.length < 16) { sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400); return true; }
    if (newToken.length > 128) { sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400); return true; }
    if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
      sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
      return true;
    }
    const cfg = getCfg();
    const configFile = path.join(baseDeps.ROOT, 'config.json');
    const file = readConfigObject(configFile);
    // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
    file.consoleToken = generated ? '' : newToken;
    atomicWriteJson(configFile, file);
    cfg.consoleToken = generated ? '' : newToken;
    atomicWriteText(path.join(baseDeps.stateDir, 'console-token'), newToken);
    setConsoleToken?.(newToken);
    log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
    sendJson({ ok: true, token: newToken, generated });
    return true;
  }

  /** POST /api/test-send —— 走与正式发送相同的闸门 */
  async function handleTestSend(ctx = {}) {
    const { readBody, sendJson } = ctx;
    const cfg = getCfg();
    const currentMode = getCurrentMode();
    const body = await readBody();
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (!allowed(kind, id, cfg)) {
      sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403);
      return true;
    }
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: `当前模式（${currentMode}）不允许发送到 ${kind}:${id}` }, 403);
      return true;
    }
    try {
      const safeMessage = escapeCqText(redactKnownTokensOnly(message));
      const bot = getBot();
      const result = kind === 'private'
        ? await bot.sendPrivateMessage(id, text(safeMessage))
        : await bot.sendGroupMessage(id, text(safeMessage));
      log(`控制台：测试发送 ${kind}:${id} 成功`);
      sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
    }
    return true;
  }

  /** POST /api/authorize/read —— 空 token 一律拒绝（否则等于免鉴权端点） */
  async function handleAuthorizeRead(ctx = {}) {
    const { readBody, sendJson } = ctx;
    const cfg = getCfg();
    const currentMode = getCurrentMode();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!token || !agentTokenOk(key, token)) {
      // 该端点对 agent 流量开放，而 MCP 的 agentApi 总是带着真实控制台令牌，
      // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
      sendJson({
        ok: false,
        error: token
          ? 'agent token 无效'
          : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具'
      }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    sendJson({ ok: true, key });
    return true;
  }

  return { handleToken, handleTestSend, handleAuthorizeRead };
}