// 错误归类 + 本地错误环形日志（0.5.63）
//
// 为什么：群里只看到「agent 处理出错（含敏感信息，已隐藏）」，远程部署又拿不到日志。
// 这里把异常归成 5 类，群里只发一句人能懂的话，完整信息留在本地 state/diag/last-errors.json。
import fs from 'node:fs';
import path from 'node:path';

export const ERROR_CODES = {
  E401: { hint: '模型鉴权失败，请检查配置里的 API key', retriable: false },
  E429: { hint: '模型服务繁忙/限流，稍后会自动重试', retriable: true },
  E502: { hint: '上游服务或网络异常，重发一次通常就好', retriable: true },
  E503: { hint: '连不上 DSH，可先切 agent.mode=local', retriable: true },
  E0: { hint: '未知错误，请导出诊断包', retriable: false }
};

/** 把任意异常归类成 { code, hint, retriable, detail } */
export function classifyError(error) {
  const msg = String(error?.message ?? error ?? '');
  const status = Number(error?.status) || 0;
  const code0 = String(error?.code ?? '');
  const detail = msg.slice(0, 500);

  if (error?.code === 'MODEL_BUSY' || status === 429 || /too busy|rate limit|繁忙|限流/i.test(msg)) {
    return { code: 'E429', ...ERROR_CODES.E429, detail };
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|鉴权|no api key|没有可用/i.test(msg)) {
    return { code: 'E401', ...ERROR_CODES.E401, detail };
  }
  const netish = /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE/i;
  if (netish.test(code0) || netish.test(msg)
    || status >= 500 || /fetch failed|socket hang up|timeout|超时/i.test(msg)) {
    return { code: 'E502', ...ERROR_CODES.E502, detail };
  }
  if (/dsh|DeepSeek Harness|event stream|事件流/i.test(msg)) {
    return { code: 'E503', ...ERROR_CODES.E503, detail };
  }
  return { code: 'E0', ...ERROR_CODES.E0, detail };
}

/** 群里展示的一句话（不含敏感内容） */
export function publicMessage(classified) {
  return `（${classified.code} ${classified.hint}）`;
}

const DIAG_DIR = (stateDir) => path.join(stateDir, 'diag');
const ERR_FILE = (stateDir) => path.join(DIAG_DIR(stateDir), 'last-errors.json');
const MAX_KEEP = 20;

/** 追加一条错误记录（环形，最多 20 条） */
export function recordError(stateDir, classified, extra = {}) {
  try {
    fs.mkdirSync(DIAG_DIR(stateDir), { recursive: true });
    const file = ERR_FILE(stateDir);
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push({
      at: new Date().toISOString(),
      code: classified.code,
      detail: classified.detail,
      ...extra
    });
    const trimmed = list.slice(-MAX_KEEP);
    fs.writeFileSync(file, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
    return trimmed.length;
  } catch {
    return 0;
  }
}

/** 读最近错误（供 /诊断 或诊断包用） */
export function readErrors(stateDir, limit = MAX_KEEP) {
  try {
    const list = JSON.parse(fs.readFileSync(ERR_FILE(stateDir), 'utf8'));
    return Array.isArray(list) ? list.slice(-limit) : [];
  } catch {
    return [];
  }
}

/** 一句话统计：最近 24 小时各码出现次数 */
export function errorSummary(stateDir, sinceMs = 24 * 3600 * 1000) {
  const now = Date.now();
  const counts = {};
  for (const e of readErrors(stateDir, MAX_KEEP)) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && now - t > sinceMs) continue;
    counts[e.code] = (counts[e.code] || 0) + 1;
  }
  return counts;
}
