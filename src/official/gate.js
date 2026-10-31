// 官方通道「接入闸门」（0.4.65）
//
// 背景：官方通道（QQ 官方机器人）代码已实现，但仍处在「上锁 + 未验证」状态（见 LOCK.md）。
// 现在的启用条件只有 `config.official.enabled === true` —— 缺 appid/secret/白名单时也会去连，
// 然后在运行期零零散散地报错。这个模块把「能不能接 / 还差什么」收敛成**一个纯函数**，
// 让：控制台能一屏显示清单、启动时能打一行结论、将来解锁只需要改一个开关。
//
// 设计约束：
//   · 纯函数（无 IO）：cfg / env / 文件系统探测结果都由调用方注入 → 可单测
//   · 只做**判断与说明**，不发消息、不连接、不改配置
//   · 未就绪时给出「下一步做什么」，而不是只给 false

/** 解锁官方通道需要满足的条件（顺序即展示顺序） */
export const OFFICIAL_CHECKLIST = Object.freeze([
  { key: 'enabled', label: '已在 config.json 打开 official.enabled', hint: '拿到验证结果前保持 false' },
  { key: 'appid', label: '填了 official.appid', hint: 'q.qq.com → 机器人 → 开发设置' },
  { key: 'secret', label: '填了 official.secret（或 state/official.json）', hint: 'secret 放 state/ 不进仓库' },
  { key: 'allow', label: '配了接收范围（allow 列表或 allowAll）', hint: '官方会话按 openid 判，默认全拒' },
  { key: 'probe', label: '跑过 scripts/official-probe.mjs 且通过', hint: '探针会验证鉴权与网关' },
]);

/** 运行时状态文案（与控制台仪表盘一致） */
export function describeOfficialState({ enabled, configured, ready, lastError } = {}) {
  if (!enabled) return configured ? '已配置未启用' : '未启用';
  if (lastError) return '连接失败';
  return ready ? '已连接' : '连接中';
}

/**
 * 判断官方通道是否可以接入。
 * @param {object} p
 * @param {object} p.cfg            config.json 的 official 段
 * @param {boolean} p.probePassed   是否已有「探针通过」的记录（调用方从 state 读，或 false）
 * @param {boolean} p.transportReady 运行时是否已连上（仅用于状态展示）
 * @param {string} [p.lastError]
 */
export function officialGate({ cfg = {}, probePassed = false, transportReady = false, lastError = '' } = {}) {
  const o = cfg && typeof cfg === 'object' ? cfg : {};
  const enabled = o.enabled === true;
  const appid = String(o.appid ?? '').trim();
  const secret = String(o.secret ?? '').trim();
  const allow = Array.isArray(o.allow) ? o.allow.filter(Boolean) : [];
  const allowAll = o.allowAll === true;

  // 「探针通过」有两个来源：跑过 official-probe（留下标记文件），或者**当前已经连上**
  // ——后者比探针更强（鉴权、网关、事件都通了），不认它会让明明在跑的实例显示"未就绪"。
  const probeFromRuntime = transportReady === true;
  const checks = {
    enabled,
    appid: Boolean(appid),
    secret: Boolean(secret),
    allow: allow.length > 0 || allowAll,
    probe: probePassed === true || probeFromRuntime,
  };

  const missing = OFFICIAL_CHECKLIST.filter((c) => !checks[c.key]).map((c) => ({
    key: c.key,
    label: c.label,
    hint: c.hint,
  }));

  const allowed = missing.length === 0;
  return {
    allowed,
    checks,
    missing,
    // 只差"打开开关"：其余都齐了
    readyToFlip: !enabled && missing.length === 1 && missing[0].key === 'enabled',
    state: describeOfficialState({
      enabled,
      configured: Boolean(appid && secret),
      ready: transportReady === true,
      lastError
    }),
    sandbox: o.sandbox === true,
    probeSource: probePassed === true ? 'marker' : (probeFromRuntime ? 'runtime' : 'none'),
    note: allowed
      ? '条件齐全：把 official.enabled 设为 true 即接入'
      : '还有 ' + missing.length + ' 项未满足（见下）'
  };
}
