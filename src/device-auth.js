// 设备配对 + 请求签名（0.4.107）
//
// 用户想要"只有控制台和手机知道"的加密。结论：**不自己发明算法**，用标准件拼出来：
//   · 配对：电脑控制台显示 6 位码（60 秒），手机输入后领到 deviceId + deviceSecret
//   · 每次请求：HMAC-SHA256(secret, method+path+timestamp+nonce+bodyHash)
//   · 服务器校验：±60 秒时间窗 + nonce 去重 + 常量时间比较 + 设备白名单
//
// 这套东西只防"请求被伪造/重放/篡改"，**不替代 TLS**：线路加密交给 Tailscale 或 HTTPS。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEVICE_AUTH_WINDOW_MS = 60 * 1000;
export const NONCE_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TTL_MS = 60 * 1000;

export function hashBody(raw) {
  return crypto.createHash('sha256').update(String(raw ?? ''), 'utf8').digest('hex');
}

/** 待签字符串：字段顺序固定，任何一方改了都要同步 */
export function signatureBase({ method = 'GET', path = '/', timestamp = 0, nonce = '', bodyHash = '' } = {}) {
  return [String(method).toUpperCase(), String(path), String(timestamp), String(nonce), String(bodyHash)].join('\n');
}

export function signRequest(secret, parts = {}) {
  return crypto.createHmac('sha256', String(secret)).update(signatureBase(parts)).digest('hex');
}

/** 常量时间比较（长度不同直接 false） */
export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

/** nonce 去重：记住最近用过的，TTL 后自动过期 */
export function createNonceCache({ ttlMs = NONCE_TTL_MS } = {}) {
  const seen = new Map();
  function sweep(now) {
    for (const [k, at] of seen) {
      if (now - at > ttlMs) seen.delete(k);
    }
  }
  return {
    /** 返回 true 表示这个 nonce 是**新的**（可以用） */
    claim(nonce, now = Date.now()) {
      const n = String(nonce || '');
      if (!n) return false;
      sweep(now);
      if (seen.has(n)) return false;
      seen.set(n, now);
      return true;
    },
    size() { return seen.size; }
  };
}

/**
 * 校验一个已签名请求。
 * @returns {{ok:boolean, error?:string}}
 */
export function verifyRequest({ secret, sign, method, path: reqPath, timestamp, nonce, bodyHash, now = Date.now(), windowMs = DEVICE_AUTH_WINDOW_MS, nonces } = {}) {
  if (!secret) return { ok: false, error: '未知设备' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, error: '缺少时间戳' };
  if (Math.abs(now - ts) > windowMs) return { ok: false, error: '时间戳超出允许窗口（可能是重放）' };
  if (!nonce) return { ok: false, error: '缺少 nonce' };
  const expect = signRequest(secret, { method, path: reqPath, timestamp, nonce, bodyHash });
  if (!safeEqualHex(expect, sign)) return { ok: false, error: '签名不匹配' };
  if (nonces && typeof nonces.claim === 'function' && !nonces.claim(nonce, now)) {
    return { ok: false, error: 'nonce 已用过（重放）' };
  }
  return { ok: true };
}

/** 设备库：state/device-auth.json（secret 明文存这里，和 console-token 同级别；state 是 gitignore 的） */
export function createDeviceStore(file) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return j && typeof j === 'object' ? j : { devices: [] };
    } catch {
      return { devices: [] };
    }
  }
  function write(data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      // guard-allow: renameSync 只写 state/device-auth.json，与其它 state 写入同一套 tmp+rename
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }
  return {
    list() {
      const d = read();
      return Array.isArray(d.devices) ? d.devices.map(({ secret, ...rest }) => rest) : [];
    },
    find(id) {
      const d = read();
      return (d.devices || []).find((x) => x.id === id) || null;
    },
    add(name = '') {
      const data = read();
      const device = {
        id: crypto.randomBytes(8).toString('hex'),
        secret: crypto.randomBytes(32).toString('hex'),
        name: String(name || '未命名设备').slice(0, 40),
        createdAt: Date.now(),
        lastSeenAt: 0,
        revoked: false
      };
      data.devices = [...(data.devices || []), device];
      write(data);
      return device;
    },
    touch(id, now = Date.now()) {
      const data = read();
      const d = (data.devices || []).find((x) => x.id === id);
      if (!d) return false;
      d.lastSeenAt = now;
      write(data);
      return true;
    },
    revoke(id) {
      const data = read();
      const d = (data.devices || []).find((x) => x.id === id);
      if (!d) return false;
      d.revoked = true;
      write(data);
      return true;
    }
  };
}

/** 配对码：内存里 6 位数字，一次性、60 秒有效 */
export function createPairingCodes({ ttlMs = PAIRING_TTL_MS } = {}) {
  let current = null;
  return {
    issue(now = Date.now()) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      current = { code, expiresAt: now + ttlMs };
      return { code, expiresAt: current.expiresAt };
    },
    /** 校验并消费（成功一次就作废） */
    consume(code, now = Date.now()) {
      if (!current) return { ok: false, error: '没有正在等待配对的码' };
      if (now > current.expiresAt) { current = null; return { ok: false, error: '配对码已过期' }; }
      if (String(code || '').trim() !== current.code) return { ok: false, error: '配对码不对' };
      current = null;
      return { ok: true };
    },
    peek() { return current ? { ...current } : null; }
  };
}
