// 控制台访问守卫（0.4.110）
//
// 三个东西，配合起来才敢把控制台放到局域网/隧道后面：
//   1) 限流：同一来源连续鉴权失败就 429，挡住暴力扫描
//   2) 审计：把"谁、从哪、做了什么、被拒原因"记下来（只记元数据，不记正文）
//   3) 设备签名校验：手机用配对得到的 secret 给每个请求签名（body 哈希在读到 body 时核对）
//
// 这里只放纯逻辑，接线在 bridge.js 与 http/prelude.js。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 固定窗口限流：按 key（通常是 IP）计数，超了就等窗口过去 */
export function createRateLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();   // key -> { count, resetAt }
  function sweep(now) {
    for (const [k, v] of hits) {
      if (now >= v.resetAt) hits.delete(k);
    }
  }
  return {
    /** 记一次（通常只在失败时调用）；返回 {ok, retryAfterMs, count, resetAt} */
    hit(key, now = Date.now()) {
      sweep(now);
      const k = String(key || 'unknown');
      const cur = hits.get(k);
      if (!cur || now >= cur.resetAt) {
        const fresh = { count: 1, resetAt: now + windowMs };
        hits.set(k, fresh);
        return { ok: fresh.count <= max, count: fresh.count, retryAfterMs: 0, resetAt: fresh.resetAt };
      }
      cur.count += 1;
      const ok = cur.count <= max;
      return { ok, count: cur.count, retryAfterMs: ok ? 0 : Math.max(0, cur.resetAt - now), resetAt: cur.resetAt };
    },
    /** 只查不记（用于"这个源现在还能不能试"） */
    peek(key, now = Date.now()) {
      sweep(now);
      const cur = hits.get(String(key || 'unknown'));
      if (!cur) return { ok: true, count: 0, retryAfterMs: 0 };
      return { ok: cur.count < max, count: cur.count, retryAfterMs: Math.max(0, cur.resetAt - now) };
    },
    clear(key) { hits.delete(String(key || 'unknown')); },
    size() { return hits.size; }
  };
}

/** 访问审计：追加 JSONL，超过上限自动丢掉最老的 */
export function createAccessLog({ file, maxLines = 2000 } = {}) {
  let lines = null;
  function load() {
    if (lines) return lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      lines = [];
    }
    return lines;
  }
  return {
    record(entry = {}) {
      const row = {
        at: Date.now(),
        ip: String(entry.ip || ''),
        method: String(entry.method || ''),
        path: String(entry.path || ''),
        ok: entry.ok !== false,
        reason: entry.reason ? String(entry.reason).slice(0, 80) : undefined,
        device: entry.device ? String(entry.device).slice(0, 32) : undefined
      };
      const buf = load();
      buf.push(JSON.stringify(row));
      if (buf.length > maxLines) buf.splice(0, buf.length - maxLines);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf.join('\n') + '\n');
      } catch { /* 审计写不进去不能影响主流程 */ }
      return row;
    },
    tail(n = 50) {
      return load().slice(-Math.max(1, n)).map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
    }
  };
}

/** sha256（hex）：body 哈希与配对签名共用 */
export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 判断一个请求是不是"本机回环"。
 * 非回环的来源一律记审计（远程访问我们想留痕）。
 */
export function isLoopback(address) {
  const a = String(address || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}
