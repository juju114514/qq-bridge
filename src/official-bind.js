// QQ 官方机器人「扫码绑定」（0.4.114）
//
// 协议不是猜的，是照着 AstrBot 的实现逆出来的（见 CHANGELOG）：
//   ① POST https://q.qq.com/lite/create_bind_task  {"key": base64(32 随机字节)}
//      → {"retcode":0,"data":{"task_id":"..."}}
//   ② 二维码内容是一个 **URL 字符串**（不是图片）：
//      https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&_wv=2
//   ③ POST https://q.qq.com/lite/poll_bind_result  {"task_id":"..."}
//      → data.status: 0/1 = 等待, 2 = 完成（带 bot_appid + bot_encrypt_secret）, 3 = 过期
//   ④ bot_encrypt_secret 用 ①里那个 key 做 AES-256-GCM 解密，明文是**裸 AppSecret 字符串**
//      nonce = 密文前 12 字节，tag = 后 16 字节，无 AAD
//
// 为什么值得做：手机用户没法去开发者后台翻 AppID/AppSecret，扫一次码就配好。
import crypto from 'node:crypto';

export const BIND_HOST = 'https://q.qq.com';
export const BIND_STATUS = { PENDING: 'pending', CREATED: 'created', EXPIRED: 'expired', UNKNOWN: 'unknown' };

/** 官方数字状态码 → 我们的语义 */
export function bindStatusName(status) {
  const n = Number(status);
  if (n === 2) return BIND_STATUS.CREATED;
  if (n === 3) return BIND_STATUS.EXPIRED;
  if (n === 0 || n === 1) return BIND_STATUS.PENDING;
  return BIND_STATUS.UNKNOWN;
}

/**
 * 生成一个绑定用的 key：32 字节随机，base64。
 * 这个 key 只在本地内存里，腾讯那边只拿到它的「锁」，解密的「钥匙」一直在我们手上。
 */
export function makeBindKey() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * 解出 AppSecret。
 *
 * 出错时抛错而不是返回空串——宁可让调用方看到「解密失败」，也不要拿着空 secret 去连。
 * @param {string} keyB64 32 字节的 base64
 * @param {string} encryptedB64 密文 base64（nonce|ct|tag）
 */
export function decryptBindSecret(keyB64, encryptedB64) {
  const key = Buffer.from(String(keyB64 ?? ''), 'base64');
  if (key.length !== 32) throw new Error('绑定密钥长度不是 32 字节');
  const raw = Buffer.from(String(encryptedB64 ?? ''), 'base64');
  if (raw.length <= 28) throw new Error('凭证密文格式异常（太短）');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  if (!plain) throw new Error('凭证解密结果为空');
  return plain;
}

/** 拼二维码内容（纯函数，好测） */
export function buildQrUrl(taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw new Error('缺少 task_id');
  return `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(id)}&_wv=2`;
}

/** 官方的 retcode 约定：HTTP 2xx **且** retcode 缺失或为 0 才算成功 */
function checkRetcode(json) {
  const rc = Number(json?.retcode ?? 0);
  if (!Number.isFinite(rc) || rc !== 0) {
    const msg = String(json?.msg ?? json?.message ?? `retcode ${json?.retcode}`);
    throw new Error(`q.qq.com 返回失败：${msg}`);
  }
  return json?.data ?? {};
}

/**
 * 绑定会话：一次绑定一个（同时扫两个码没意义，还会串）。
 * @param {{fetchImpl?:Function, log?:(m:string)=>void, timeoutMs?:number, now?:()=>number}} opts
 */
export function createBindSession(opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const timeoutMs = Number(opts.timeoutMs) || 10_000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  // 测试用：可以注入固定的 key 工厂，生产环境永远走 makeBindKey（32 字节随机）
  const keyFactory = typeof opts.keyFactory === 'function' ? opts.keyFactory : makeBindKey;
  let current = null;   // { taskId, key, startedAt }

  async function post(path, body) {
    const res = await fetchImpl(`${BIND_HOST}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 交给下面判空 */ }
    if (!res.ok || !json) throw new Error(`q.qq.com HTTP ${res.status}：${String(text).slice(0, 120)}`);
    return checkRetcode(json);
  }

  return {
    /** ① 创建绑定任务，返回二维码内容 */
    async start() {
      const key = keyFactory();
      const data = await post('/lite/create_bind_task', { key });
      const taskId = String(data?.task_id ?? '').trim();
      if (!taskId) throw new Error('q.qq.com 没返回 task_id');
      current = { taskId, key, startedAt: now() };
      log(`[official-bind] 已创建绑定任务 task_id=${taskId.slice(0, 8)}…`);
      return { taskId, qrUrl: buildQrUrl(taskId), interval: 2 };
    },

    /** ③ 轮询状态；完成时顺手解密 secret */
    async poll(taskId) {
      const id = String(taskId ?? '').trim();
      if (!id) throw new Error('缺少 task_id');
      const mine = current && current.taskId === id ? current : null;
      if (!mine) throw new Error('这个 task_id 不是本进程发起的（重启后请重新扫码）');
      const data = await post('/lite/poll_bind_result', { task_id: id });
      const status = bindStatusName(data?.status);
      if (status !== BIND_STATUS.CREATED) return { status, appid: '', secret: '' };

      const appid = String(data?.bot_appid ?? '').trim();
      const enc = String(data?.bot_encrypt_secret ?? '').trim();
      if (!appid || !enc) {
        return { status: BIND_STATUS.UNKNOWN, appid: '', secret: '', error: '扫码成功但腾讯没返回完整凭证' };
      }
      const secret = decryptBindSecret(mine.key, enc);
      current = null;   // 一次性：成功即作废
      // 日志里只留前 6 位，避免整串密钥进日志
      log(`[official-bind] 绑定成功 appid=${appid} secret=***${secret.slice(-4)}`);
      return { status: BIND_STATUS.CREATED, appid, secret };
    },

    /** 只读：当前有没有进行中的绑定 */
    peek() {
      return current ? { taskId: current.taskId, startedAt: current.startedAt } : null;
    }
  };
}
