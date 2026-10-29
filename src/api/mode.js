// 模式切换（从 bridge.js 抽出的第九片）
//
//   POST /api/mode   chat / closed-agent / reserved / reserved2（simulation 为别名）
//
// 三个模块级 let 都要读写，统一走 getter/setter：
//   currentMode、lastMode、closedAgentPreset
//
// 原代码里两处容易忽略的细节，原样保留：
//   1. 写穿 DSH 设置成功与否要回报 dshSynced —— 只写本地会被 5 秒一次
//      的 refreshMode 轮询回滚，用户看不到任何报错
//   2. 判断「模式真的变了吗」必须用**归一后**的值：用原始 body.mode 比较会把
//      simulation 与 reserved2 当成两种模式，从而误清定时器与排队投递

export function createModeHandler(deps = {}) {
  const {
    sendJson, readBody, log,
    normalizeModeInput, VALID_MODES,
    readJsonSafe, atomicWriteJson, path, stateDir,
    api, unwrap,
    getMode, setMode, setLastMode, setClosedAgentPreset,
    cleanupSocialForModeChange, clearAllSocialV2Timers, drainAllPromptQueues,
    reconcileSessionPolicies, socialV2, setupSleepTimerV2, scheduleProactiveCheckV2
  } = deps;

  return async function handleMode(req, url) {
    // 原代码用模块级 STATE_DIR；抽出来后由依赖传入
    const STATE_DIR = stateDir;

          if (req.method === 'POST' && url.pathname === '/api/mode') {
            const body = await readBody();
            // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
            const requestedMode = normalizeModeInput(body.mode);
            if (!requestedMode) {
              sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
              return;
            }
            const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
            const next = {
              mode: requestedMode,
              // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
              ...(body.closedAgentPreset !== undefined
                ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
                : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
            };
            atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
            // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
            setClosedAgentPreset(next.closedAgentPreset);
            // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
            // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
            // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
            // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
            let dshSynced = false;
      let currentMode = getMode();
            try {
              // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
              // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
              unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
              dshSynced = true;
            } catch (error) {
              log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
            }
            // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
            // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
            if (currentMode === 'reserved' && requestedMode !== 'reserved') {
              cleanupSocialForModeChange();
              log('控制台：模式离开一代仿真模式，清理社交状态');
            }
            if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
              clearAllSocialV2Timers();
              drainAllPromptQueues('模式切换，已取消排队中的投递');
              log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
            }
            setMode(requestedMode);
            setLastMode(requestedMode);
            reconcileSessionPolicies();
            if (requestedMode === 'reserved2') {
              for (const key of socialV2.conversations.keys()) {
                setupSleepTimerV2(key);
                scheduleProactiveCheckV2(key);
              }
              log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
            }
            log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
            sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
            return;
          }
  };
}
