// 控制台：DSH 模型与思考强度（/api/dsh/model、/api/dsh/effort）。
//
// 为什么拆出来：这一段有 18 个依赖、还带两个轻量缓存，是 startConsoleServer 里
// 典型的"内聚但很长"的一块。抽出来之后 bridge 只留两行分发。
//
// 依赖分两类：
//   · baseDeps —— 启动时给一次（配置、日志、模型目录、缓存）
//   · 每次调用的 ctx —— sendJson / readBody 是**每请求**的（不能缓存！踩过 ERR_HTTP_HEADERS_SENT）

export function createConsoleDshHandlers(deps = {}) {
  const {
    getCfg, log = () => {},
    withTimeout, fetchModelCatalog, unwrap,
    reasoningEffortOptions, reasoningEffortDefault, normalizeReasoningEffort,
    errorLogged = new Set(),
    bumpModelEpoch = () => {},
    readConfigObject, atomicWriteJson, configFile
  } = deps;

  // 并发请求时共用同一次 catalog 请求（控制台刷新很频繁）
  let modelCatalogInFlight = null;

  async function handleModel(ctx = {}) {
    const { sendJson } = ctx;
    const cfg = getCfg();
    const provider = String(cfg?.dsh?.provider || 'deepseek-official');
    const model = String(cfg?.dsh?.model || 'deepseek-flash');
    // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
    let options = reasoningEffortOptions.slice();
    let labels = {};
    let providerDefault = null;
    let catalogSource = 'fallback';
    try {
      if (!modelCatalogInFlight) {
        modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
          .finally(() => { modelCatalogInFlight = null; });
      }
      const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
      const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
      const entry = (group?.models ?? []).find((m) => m?.id === model);
      const efforts = entry?.reasoning?.efforts ?? [];
      const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => reasoningEffortOptions.includes(id));
      if (advertised.length) {
        options = advertised;
        labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
        providerDefault = entry.reasoning.defaultEffort ?? null;
        catalogSource = 'dsh';
      }
    } catch (error) {
      // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
      const reason = String(error?.message ?? error);
      if (!errorLogged.has(reason)) {
        errorLogged.add(reason);
        log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
      }
    }
    sendJson({
      provider,
      model,
      reasoningEffort: String(cfg?.dsh?.reasoningEffort || reasoningEffortDefault),
      options,
      labels,
      default: reasoningEffortDefault,
      providerDefault,
      catalogSource,
      // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
      // 控制台要把这点明确告诉管理员，避免"只想调 QQ 助手却改了 Web GUI 新会话默认"的意外。
      globalSideEffect: true
    });
    return true;
  }

  async function handleEffort(ctx = {}) {
    const { sendJson, readBody } = ctx;
    const body = await readBody();
    let effort;
    try { effort = normalizeReasoningEffort(body.reasoningEffort); }
    catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; }
    // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
    const file = readConfigObject(configFile);
    file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
    atomicWriteJson(configFile, file);
    const cfg = getCfg();
    cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
    // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
    bumpModelEpoch();
    log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
    sendJson({ ok: true, reasoningEffort: effort });
    return true;
  }

  return { handleModel, handleEffort };
}