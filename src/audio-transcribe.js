// 语音转写（ASR）客户端：给「视频理解」抽出来的音轨用。
//
// 设计约束（和 ocr.js 一致）：
//   · **只探测、不代启动**：ASR 是常驻 Python 服务（scripts 侧，见 docs/guides/VIDEO.md），
//     桥接只 HTTP 调用；不可用就降级成"只有画面"，绝不因为 ASR 挂了把整条视频读失败。
//   · 可用性进程内缓存（同一进程里服务要么在要么不在，没必要每次都探）。
//   · 结果里带 seconds（服务端耗时），便于日志判断是不是慢到该降级。

const DEFAULT_BASE = 'http://127.0.0.1:5111';
const availability = new Map();

/** 拼出 ASR 服务地址：显式配置 > 环境变量 > 默认端口。 */
export function asrBaseUrl(opts = {}) {
  const raw = String(opts.baseUrl ?? opts.asrUrl ?? process.env.QQBOT_ASR_URL ?? '').trim();
  return (raw || DEFAULT_BASE).replace(/\/+$/, '');
}

/** ASR 服务是否可用（GET /health）。按 baseUrl 缓存一次结果。 */
export async function asrAvailable(opts = {}) {
  const base = asrBaseUrl(opts);
  if (availability.has(base)) return availability.get(base);
  let ok = false;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(Number(opts.probeTimeoutMs) || 1200) });
    ok = res.ok;
  } catch { ok = false; }
  availability.set(base, ok);
  return ok;
}

/** 供测试/运维手动清缓存（比如刚把服务起来）。 */
export function resetAsrCache() { availability.clear(); }

/**
 * 转写一个本地音频文件。
 * @param {string} file 本地 wav/mp3 路径（16k 单声道最省）
 * @returns {Promise<{ok:boolean, text?:string, seconds?:number, reason?:string, error?:string}>}
 */
export async function transcribeFile(file, opts = {}) {
  const base = asrBaseUrl(opts);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  try {
    const res = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ path: String(file) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, error: `ASR 服务返回 HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
      return { ok: false, reason: 'asr-failed', error: String(data?.error ?? 'ASR 返回 ok=false') };
    }
    return {
      ok: true,
      text: String(data.text ?? '').trim(),
      seconds: Number(data.seconds) || 0
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    const reason = /timeout|abort/i.test(message) ? 'timeout' : 'unreachable';
    return { ok: false, reason, error: `ASR 调用失败：${message}` };
  }
}

/**
 * 把转写文本压成"带时间戳感"的段落（服务端目前不带时间戳，这里按句切分并补估算时间）。
 * 为什么要它：视频里"哪句在第几秒说"对理解剧情很关键，而纯文本丢掉了先后顺序的成本。
 */
export function formatTranscript(text, { durationSec = 0, maxChars = 1200 } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…（转写过长，已截断）` : body;
  const sentences = clipped.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 1 || !(durationSec > 0)) return clipped;
  // 没有真实时间戳时，按句子字数加权分配时间（只是给人读的近似值，不声称精确）
  const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
  let cursor = 0;
  return sentences.map((s) => {
    const span = (s.length / total) * durationSec;
    const at = cursor;
    cursor += span;
    return `[~${at.toFixed(1)}s] ${s}`;
  }).join('\n');
}
