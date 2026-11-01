// 官方通道的错误与退避策略（0.4.113）
//
// 单独一个模块的理由：qqbot-official.js 已经 300 行，再塞 60 行策略就把文件顶到体积上限；
// 而且这两件事纯函数、好测，跟 WS/HTTP 传输没有耦合。
/** 可能要重试的状态码：限流 + 网关/上游抖动 */
export const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * 官方错误码 → 人话。
 *
 * 订正记录（0.4.113）：上一版有几条是**我自己编的**（11241/304003/304023/304034/11244），
 * 官方码表里根本不是那个意思——11241 是「参数里缺少 token」，304023 甚至是「推送成功等审核」。
 * 这里只保留能从官方文档/实测确认的码；不确定的一律不写，宁可只显示原始信息。
 */
export const OFFICIAL_ERROR_HINTS = {
  // 被动回复（配额类，等再久也没用）
  40034128: '被动回复的时间或次数已超限（群聊 5 分钟 5 条 / 单聊 60 分钟 4 条），这条只能改发主动消息',
  40034005: '回复用的 msg_id 已过期',
  304103: '消息 ID 已过期，不能再回复',
  40034024: 'msg_id 无效或越权',
  // 幂等（可能已经发成功了）
  40054005: '同一条消息的 msg_seq 重复（很可能上一次其实已经发出去了）',
  // 限流 / 频控
  40034100: '主动消息超过频控上限',
  1100100: '风控限频：消息被暂时拦截',
  20028: '子频道消息触发限频',
  // 内容 / 参数
  40034006: '消息内容违规',
  40054007: '消息长度超限',
  50006: '消息内容为空',
  // markdown（码表来自官方「发送群聊消息 / 发送单聊消息」两页）
  22006: 'msg_type 与内容不匹配（发 markdown 时 content 必须为空）',
  40034008: 'markdown 参数里有空值',
  40034009: 'markdown 参数里有换行符',
  40034011: '无效的 markdown 内容',
  40034124: 'markdown 消息参数错误',
  40034127: '没有 markdown 模板权限',
  304036: '没有 markdown 模板权限（频道场景需要内邀）',
  40054010: '不允许发送 URL（群里链接太多会被拦）',
  40054018: '消息过长或异常',
  40054007: '消息长度超限',
  // 凭据
  100016: 'AppID/AppSecret 不正确（拿 token 就失败了）',
  100017: 'access_token 与 AppID 不匹配'
};

/** 这些码重试没有意义（配额/内容/权限问题，等一等也不会好） */
export const NO_RETRY_CODES = new Set([
  40034128, 40034005, 304103, 40034024,
  40034100, 40034006, 40054007, 50006, 22006,
  50056, 304036, 40034127,
  100016, 100017
]);

/** 这个码表示"大概已经发过了"，应当当成功处理，绝不能继续重试 */
export const DUPLICATE_CODE = 40054005;

/**
 * 官方两张码表里**查不到**的码。
 * 只是留档：不要用它们驱动降级/重试逻辑（来路不明的码最容易被误判）。
 */
export const UNVERIFIED_CODES = new Set([50056, 11241, 11244, 304003, 304023, 22009, 100017]);

/**
 * 判定一次响应到底算不算成功。
 *
 * 两个坑：
 *  · 官方 201/202 表示"异步操作成功"，但**响应体里可能带 error body**；
 *  · 只看 res.ok 会把它们当成发送成功。
 * @returns {{ok:boolean, code:number, retryable:boolean, duplicate:boolean, reason:string}}
 */
export function classifyOfficialResult(status, data, rawText = '') {
  const body = data && typeof data === 'object' ? data : {};
  const code = Number(body.err_code ?? body.code ?? 0) || 0;
  if (code === DUPLICATE_CODE) {
    return { ok: true, code, retryable: false, duplicate: true, reason: describeOfficialError(status, body, rawText) };
  }
  const httpOk = Number(status) >= 200 && Number(status) < 300;
  const ok = httpOk && code === 0;
  const retryable = !ok && !NO_RETRY_CODES.has(code) && RETRYABLE_STATUS.has(Number(status));
  return { ok, code, retryable, duplicate: false, reason: ok ? '' : describeOfficialError(status, body, rawText) };
}

/**
 * 算出这次失败要等多久再重试；返回 null 表示不要重试。
 *
 * 依据顺序：服务端 `retry-after` 头 → 指数退避（带抖动）→ 超过次数就放弃。
 * @param {{status:number, retryAfterHeader?:string|null, attempt?:number, maxAttempts?:number}} args
 * @returns {number|null} 毫秒
 */
export function retryDelayMs({ status, retryAfterHeader = null, attempt = 1, maxAttempts = 3 } = {}) {
  if (!RETRYABLE_STATUS.has(Number(status))) return null;
  if (Number(attempt) >= Number(maxAttempts)) return null;
  const secs = Number(String(retryAfterHeader ?? '').trim());
  if (Number.isFinite(secs) && secs > 0) {
    // 服务端给了就听它的，但别真的挂 5 分钟
    return Math.min(secs * 1000, 10_000);
  }
  const base = 400 * 2 ** (Number(attempt) - 1);   // 400 → 800 → 1600
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(base + jitter, 5_000);
}

/** 把 {status, data} 翻成一句能看懂的中文（原样保留服务端信息，方便排查） */
export function describeOfficialError(status, data, rawText = '') {
  const code = Number(data?.err_code ?? data?.code ?? 0);
  const serverMsg = String(data?.message ?? data?.msg ?? rawText ?? '').slice(0, 160);
  const hint = OFFICIAL_ERROR_HINTS[code] || '';
  const parts = [`HTTP ${status}`];
  if (code) parts.push(`code ${code}`);
  if (serverMsg) parts.push(serverMsg);
  const head = parts.join(' · ');
  return hint ? `${head}\n提示：${hint}` : head;
}

