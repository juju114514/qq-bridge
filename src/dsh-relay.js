// 家庭中继（0.5.55 · P3）
//
// 为什么需要它：DSH 只监听 127.0.0.1（这是它自己的安全设计，不该拆）。
// 手机要在家里用上 PC 的算力，就必须有人在中间做一段**同网段转发**。
//
// 两个方案，代码只实现第二个：
//   A. SSH 反向隧道 —— 最安全，但 Windows 要装 OpenSSH Server（需要管理员）
//   B. 本机 TCP 转发 —— 无管理员权限，靠「只允许私有网段」+ 防火墙兜底
//
// 重要：这是**透明 TCP 转发**，不是鉴权网关。DSH 自己的启动令牌/会话 cookie 仍在链路里，
// 所以它只敢绑在内网。**不要**把它映射到公网端口。
import net from 'node:net';

/** 私有网段判断（用于拦掉公网来源） */
export function isPrivateAddress(ip = '') {
  const s = String(ip).replace(/^::ffff:/, '');
  if (s === '::1' || s === '127.0.0.1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * @param {{target:{host?:string, port:number}, listen:{host?:string, port:number},
 *          allowRemote?:boolean, log?:Function, idleTimeoutMs?:number}} opts
 */
export function createRelay(opts = {}) {
  const {
    target = { host: '127.0.0.1', port: 58783 },
    listen = { host: '0.0.0.0', port: 58784 },
    allowRemote = false,
    log = () => {},
    idleTimeoutMs = 10 * 60 * 1000
  } = opts;

  const stats = { connections: 0, rejected: 0, bytesOut: 0, bytesIn: 0, startedAt: 0 };
  let server = null;

  function handle(socket) {
    const peer = String(socket.remoteAddress || '');
    if (!allowRemote && !isPrivateAddress(peer)) {
      stats.rejected += 1;
      log(`[relay] 拒绝非内网来源 ${peer}`);
      socket.destroy();
      return;
    }
    stats.connections += 1;
    const upstream = net.connect(target.port, target.host || '127.0.0.1');
    upstream.setNoDelay(true);
    socket.setNoDelay(true);
    upstream.on('data', (d) => { stats.bytesIn += d.length; socket.write(d); });
    socket.on('data', (d) => { stats.bytesOut += d.length; upstream.write(d); });
    const bye = () => { try { socket.destroy(); } catch { /* ignore */ } try { upstream.destroy(); } catch { /* ignore */ } };
    upstream.on('error', bye);
    socket.on('error', bye);
    upstream.on('close', bye);
    socket.on('close', bye);
    socket.setTimeout(idleTimeoutMs, bye);
    upstream.setTimeout(idleTimeoutMs, bye);
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = net.createServer(handle);
      server.once('error', reject);
      server.listen(listen.port, listen.host || '0.0.0.0', () => {
        stats.startedAt = Date.now();
        log(`[relay] ${listen.host || '0.0.0.0'}:${listen.port} → ${target.host}:${target.port}（allowRemote=${allowRemote}）`);
        resolve(stats);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    });
  }

  /** 实际监听地址（测试要用；port=0 时才知道真实端口） */
  function address() {
    try { return server?.address() || null; } catch { return null; }
  }

  return { start, stop, address, stats: () => ({ ...stats }), isPrivateAddress };
}
