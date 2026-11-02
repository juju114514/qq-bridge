// DSH 连通性探测（0.5.44）
//
// 为什么需要：手机上桥接连的是"另一台机器上的 DSH"，出问题时的表现是一句话：
//   「DSH 鉴权不可用：没有可用的 launch token…」
// 用户完全无法判断到底卡在哪一步 —— 地址不通？鉴权失败？还是 DSH 压根没开？
//
// 这个模块把排查拆成可验证的几段，并给出**下一步该做什么**：
//   1. 地址可达吗（TCP/HTTP）
//   2. 需要鉴权吗（401？
//   3. 鉴权手段齐不齐（launch token / 浏览器会话密钥）
//   4. 远程地址有没有 allowRemote（不发凭据给非回环地址）
//
// 2026-11-03 实测依据：DSH 只监听 127.0.0.1，手机要通过 `adb reverse` / `ssh -L` /
// frp 之类把对端端口映射成自己的回环端口，否则永远连不上。
import net from 'node:net';

export function isLoopbackBaseUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

/** TCP 连通性（不依赖 HTTP 语义，先确认端口通） */
export function probeTcp(baseUrl, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let host = '';
    let port = 0;
    try {
      const u = new URL(String(baseUrl));
      host = u.hostname;
      port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    } catch {
      resolve({ ok: false, reason: '地址格式不对' });
      return;
    }
    const sock = net.connect({ host, port });
    const done = (result) => { try { sock.destroy(); } catch { /* ignore */ } resolve(result); };
    const timer = setTimeout(() => done({ ok: false, reason: `${timeoutMs}ms 内没连上（端口没开 / 被防火墙挡 / 隧道没建）` }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    sock.once('connect', () => { clearTimeout(timer); done({ ok: true, host, port }); });
    sock.once('error', (e) => { clearTimeout(timer); done({ ok: false, reason: String(e?.code || e?.message || e) }); });
  });
}

/**
 * 综合探测。
 * @param {{baseUrl:string, authToken?:string, allowRemote?:boolean, hasSessionSecret?:boolean,
 *          fetchImpl?:Function, probeImpl?:Function}} opts
 */
export async function probeDsh(opts = {}) {
  const {
    baseUrl = '',
    authToken = '',
    allowRemote = false,
    hasSessionSecret = false,
    fetchImpl = (...a) => fetch(...a),
    probeImpl = probeTcp
  } = opts;

  const loopback = isLoopbackBaseUrl(baseUrl);
  const steps = [];
  const hints = [];

  if (!baseUrl) {
    return { ok: false, loopback: false, steps, hints: ['config.json 里没有 dsh.baseUrl —— 先在「接入与登录」页填 DSH 地址'] };
  }

  // 1) 端口
  const tcp = await probeImpl(baseUrl);
  steps.push({ name: 'tcp', ok: tcp.ok, detail: tcp.ok ? `端口可达 ${tcp.host}:${tcp.port}` : tcp.reason });
  if (!tcp.ok) {
    hints.push(loopback
      ? 'DSH 可能没启动（启动后端口每次都会变，用控制台的"探测端口"重新发现）'
      : '远程 DSH 通常只监听对端 127.0.0.1：请先用 `adb reverse tcp:3080 tcp:<对端端口>`、`ssh -L` 或 frp 把它映射成本机回环端口，再把 dsh.baseUrl 指向映射后的地址');
    return { ok: false, loopback, steps, hints };
  }

  // 2) HTTP 是否要鉴权
  let status = 0;
  try {
    const res = await fetchImpl(baseUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    status = res.status;
    try { await res.body?.cancel(); } catch { /* ignore */ }
  } catch (error) {
    steps.push({ name: 'http', ok: false, detail: String(error?.message ?? error).slice(0, 120) });
    hints.push('端口通但 HTTP 不通：可能不是 DSH 服务，或中间有代理拦了');
    return { ok: false, loopback, steps, hints };
  }
  const needAuth = status === 401 || status === 403;
  steps.push({ name: 'http', ok: true, detail: `HTTP ${status}${needAuth ? '（需要鉴权）' : '（匿名可访问）'}` });

  // 3) 鉴权手段
  if (needAuth) {
    if (!authToken && !hasSessionSecret) {
      steps.push({ name: 'auth', ok: false, detail: '没有 launch token，也没有浏览器会话密钥' });
      hints.push(loopback
        ? '本机 DSH：确认 DSH_HOME 指向真正的 .dsh 目录（要读 .credentials.yaml 里的 browser-session 密钥）'
        : '远程 DSH：把对端 ~/.dsh/.credentials.yaml 里的 client-connection/browser-session 密钥复制到本机同路径，或在 config.json 里填 dsh.authToken');
      return { ok: false, loopback, steps, hints };
    }
    steps.push({ name: 'auth', ok: true, detail: authToken ? '有 dsh.authToken' : '有浏览器会话密钥' });

    // 4) 远程地址的安全闸
    if (!loopback && authToken && !allowRemote) {
      steps.push({ name: 'allowRemote', ok: false, detail: 'baseUrl 不是回环地址，但没开 dsh.allowRemote' });
      hints.push('DSH 的 launch token 是进程启动凭据，桥接拒绝把它发往非回环地址；确实要走远程请在 config.json 里设 `"dsh": { "allowRemote": true }`');
      return { ok: false, loopback, steps, hints };
    }
  }

  return { ok: true, loopback, steps, hints };
}
