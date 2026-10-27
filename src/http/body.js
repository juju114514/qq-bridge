/**
 * 请求体读取（JSON，带上限与超时）。
 *
 * 从 bridge.js 的 `readBody()` 原样搬出来，**错误文案与状态码逐字保留**：
 * 控制台与测试都在断言这些字符串（`请求体过大（超过 1MB）`、`请求体必须是 JSON 对象`…），
 * 改一个字就等于改契约。
 *
 * 约束（VM 注入）：不 import、无顶层 await。
 */

/** 1MB：控制台最大的请求是「保存人格卡」，64KB 上限之外还有富余。 */
export const MAX_BODY_BYTES = 1_000_000;
/** 30s：慢速上传（手机热点）也不该被误杀，但挂死的连接必须放掉。 */
export const BODY_TIMEOUT_MS = 30000;

/**
 * 读并解析 JSON 请求体。
 * @returns {Promise<object>} 空 body → `{}`（历史行为：允许 POST 不带 body）
 * @throws {Error & { statusCode: number }} 与旧实现一致的四类错误
 */
export function readJsonBody(req, { maxBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let bodyTimer = null;

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      const err = new Error(message);
      err.statusCode = status;
      reject(err);
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      resolve(val);
    };

    // 提前按 Content-Length 拒绝超限请求体（不必等数据流）
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      fail(413, '请求体过大（超过 1MB）');
      return;
    }
    bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), timeoutMs);

    req.on('data', (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        req.pause();
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) { done({}); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(400, '请求体必须是 JSON 对象');
        return;
      }
      done(parsed);
    });
    // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
    req.on('error', () => fail(400, '请求体读取失败'));
    req.on('aborted', () => fail(400, '请求体读取中断'));
  });
}
