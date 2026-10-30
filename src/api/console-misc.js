// 控制台"杂项"路由 —— 波次 4 第二批从 bridge.js 内联搬出来的 6 条。
//
// 它们原先散在 bridge 的 if 链里，各自 new 一次 handler；现在统一成
// 「匹配路径 → 委托 → 返回 true/false」的派发链契约。
//
// 为什么单独成文件而不是塞进已有模块：这 6 条跨了三个域（会话待办 / DSH 模型 /
// 控制台运维 / 提醒投递），归到哪个域都不合适；先集中在这里，等某个域长大了再拆。
export async function handleConsoleMiscRoutes(req, url, deps = {}) {
  const p = url.pathname;
  const {
    pending,
    consoleDsh,
    getConsoleOps,
    createConsoleNotifyHandler,
    notifyDeps,
    sendJson,
    readBody,
    log,
    createWhitelistHandler, createSecurityHandler, handleImages,
    cfgGet, rootDir, pathModule, crypto, stateDir,
    getStateDirHardened, setStateDirHardened, manualDirCommand, hardenStateDirAcl,
    readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies,
    res, writeHtml, fs, api, unwrap, handleStatus, createModeHandler, modeDeps, handleInject,
    createVoiceSendHandler, voiceSendDeps, handleSend, workspaceReset,
    saveState, saveSocialV2State, releaseLock, setTimeoutFn = setTimeout, exitFn = (code) => process.exit(code)
  } = deps;

  // GET /api/pending —— 待回答的提问 / 待审批的工具调用
  if (req.method === 'GET' && p === '/api/pending') {
    const list = [];
    for (const [key, item] of pending.entries()) {
      list.push({
        key,
        kind: item.kind,
        sessionId: item.sessionId,
        ...(item.kind === 'approval' ? { toolName: item.toolName, reason: item.reason, approvalId: item.approvalId } : {}),
        ...(item.kind === 'question' ? { questions: item.questions } : {})
      });
    }
    sendJson({ pending: list });
    return true;
  }

  // GET /api/dsh/model · POST /api/dsh/effort —— DSH 的模型与思考档位
  if (req.method === 'GET' && p === '/api/dsh/model') {
    await consoleDsh.handleModel({ sendJson, readBody });
    return true;
  }
  if (req.method === 'POST' && p === '/api/dsh/effort') {
    await consoleDsh.handleEffort({ sendJson, readBody });
    return true;
  }

  // POST /api/console/token · POST /api/test-send —— 控制台令牌与测试发送
  if (req.method === 'POST' && p === '/api/console/token') {
    await getConsoleOps().handleToken({ readBody, sendJson });
    return true;
  }
  if (req.method === 'POST' && p === '/api/test-send') {
    await getConsoleOps().handleTestSend({ readBody, sendJson });
    return true;
  }

  // POST /api/console/notify-ai —— 后台向指定会话投递提醒
  if (req.method === 'POST' && p === '/api/console/notify-ai') {
    await createConsoleNotifyHandler(notifyDeps)(req, url);
    return true;
  }


  // GET/POST /api/whitelist —— 白名单可视化编辑（写 config.json + 热更新）
  if (p === '/api/whitelist') {
    await createWhitelistHandler({
      sendJson, readBody, log,
      getCfg: () => cfgGet(), rootDir, path: pathModule,
      readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies
    })(req, url);
    return true;
  }

  // GET/POST /api/security —— 安全拦截 / 目录 ACL / 手动加固
  if (p === '/api/security') {
    await createSecurityHandler({
      sendJson, readBody, log,
      getCfg: () => cfgGet(), rootDir, path: pathModule, crypto,
      stateDir, getStateDirHardened, setStateDirHardened,
      manualDirCommand, hardenStateDirAcl,
      readConfigObject, atomicWriteJson
    })(req, url);
    return true;
  }

  // GET /api/images/message —— 取某条消息里的图片（终端处理器，自己写响应）
  if (req.method === 'GET' && p === '/api/images/message') {
    await handleImages(req, url);
    return true;
  }


  // GET / —— 控制台首页（静态文件，缺失时给一句人话）
  if (req.method === 'GET' && p === '/') {
    try {
      writeHtml(res, fs.readFileSync(pathModule.join(rootDir, 'public', 'console.html'), 'utf8'));
    } catch {
      writeHtml(res, '控制台页面缺失：qq-bridge/public/console.html');
    }
    return true;
  }

  // GET /api/status —— 运行状态（已迁到 src/api/status.js，这里只做分派）
  if (req.method === 'GET' && p === '/api/status') {
    handleStatus(req);
    return true;
  }

  // GET /api/presets —— DSH 的 agent 预设列表
  if (req.method === 'GET' && p === '/api/presets') {
    let presets = [];
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
      presets = list.map((x) => ({ id: x.id, trust: x.trust ?? 'system' }));
    } catch {}
    sendJson({ presets });
    return true;
  }

  // POST /api/mode —— 切换运行模式（会清理/重建定时器与会话策略）
  if (req.method === 'POST' && p === '/api/mode') {
    await createModeHandler(modeDeps)(req, url);
    return true;
  }

  // POST /api/authorize/read —— 读取授权状态（只读语义，POST 只是沿用老契约）
  if (req.method === 'POST' && p === '/api/authorize/read') {
    await getConsoleOps().handleAuthorizeRead({ readBody, sendJson });
    return true;
  }

  // POST /api/inject —— 外部注入一条 prompt（测试/联调用）
  if (req.method === 'POST' && p === '/api/inject') {
    await handleInject(req, url);
    return true;
  }


  // POST /api/voice/send · /api/send/voice —— 语音发送（操作者通道 / AI 通道分流在模块内部）
  if (req.method === 'POST' && (p === '/api/voice/send' || p === '/api/send/voice')) {
    await createVoiceSendHandler(voiceSendDeps)(req, url);
    return true;
  }

  // POST /api/send/{group,private,reply} —— 统一发送端点（频率/引用/敏感词都在模块里）
  if (req.method === 'POST' && (p === '/api/send/group' || p === '/api/send/private' || p === '/api/send/reply')) {
    await handleSend(req, url);
    return true;
  }

  // POST /api/workspace/reset —— 清空 DSH 工作区
  if (req.method === 'POST' && p === '/api/workspace/reset') {
    await workspaceReset.resetAll({ sendJson });
    return true;
  }

  // POST /api/restart —— 重启桥接（先把状态落盘，再 releaseLock + exit）
  if (req.method === 'POST' && p === '/api/restart') {
    sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
    setTimeoutFn(() => {
      log('控制台：重启桥接');
      // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
      // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
      try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
      try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
      releaseLock();
      exitFn(0);
    }, 500);
    return true;
  }

  return false;
}