// 通道模式闸的落盘部分（N3）：认领 / 心跳 / 释放。
//
// 文件：state/channel-mode.json
// 只在 bridge 启动时和插件 enable 时调用；心跳由各自的定时器刷新。
import { claimMode, shouldRelease, describeMode, DEFAULT_TTL_MS } from './channel-mode.js';

export function createChannelModeStore({ fs, path, stateDir, ttlMs = DEFAULT_TTL_MS } = {}) {
  const file = path.join(stateDir, 'channel-mode.json');

  function read() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      return j && typeof j === 'object' ? j : null;
    } catch { return null; }
  }

  function write(record) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
      return true;
    } catch { return false; }
  }

  /** 尝试认领；失败时返回持有者信息，调用方负责降级。 */
  function claim(mode, { pid = process.pid, note = '' } = {}) {
    const current = read();
    const r = claimMode({ current, mode, pid, ttlMs, note });
    if (r.ok) write(r.record);
    return r;
  }

  /** 心跳续期：只有自己还持有时才写，避免把别人的认领覆盖成自己的。 */
  function heartbeat(mode, { pid = process.pid, note = '' } = {}) {
    const current = read();
    if (!current) return false;
    if (!shouldRelease(current, { mode, pid })) return false;
    return write({ ...current, at: Date.now(), note });
  }

  function release(mode, { pid = process.pid } = {}) {
    const current = read();
    if (!shouldRelease(current, { mode, pid })) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  return { read, claim, heartbeat, release, describe: () => describeMode(read()), file };
}

/**
 * 给常驻进程用的封装：开局认领 → 定时心跳 → 退出释放。
 *
 * 放这里而不是 bridge.js：bridge 有行数棘轮，而且这段逻辑要能被单测覆盖。
 * @returns {{ ok: boolean, store: object, stop: () => void, reason?: string, holder?: object }}
 */
export function startBridgeChannelGuard({
  fs, path, stateDir, pid = process.pid, log = () => {},
  intervalMs = 20_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  enabled = true,
} = {}) {
  const store = createChannelModeStore({ fs, path, stateDir });
  if (!enabled) {
    // sidecar-only：只提供控制台 / 契约 / 定时器，不连网关，也不占通道
    log('sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领');
    return { ok: false, store, disabled: true, stop: () => {} };
  }
  let claim = store.claim('bridge', { pid, note: 'sidecar 通道' });
  if (!claim.ok) {
    // 脏环境实测（2026-10-31）：桥接 restart 时旧进程的认领还在 TTL 内（60s），
    // 新实例被判"被另一个 bridge 占着"→ 干脆不连 QQ，日志只有一行 warning。
    // 和插件侧一样按 pid 存活性判断：持有者已退出就直接接管。
    const holderPid = Number(claim?.holder?.pid ?? 0);
    let holderAlive = false;
    try { if (holderPid > 0) { process.kill(holderPid, 0); holderAlive = true; } } catch { holderAlive = false; }
    if (holderPid > 0 && !holderAlive) {
      try { fs.rmSync(store.file, { force: true }); } catch { /* ignore */ }
      log(`通道持有者 pid ${holderPid} 已退出，接管通道`);
      claim = store.claim('bridge', { pid, note: 'sidecar 通道' });
    }
  }
  if (!claim.ok) {
    log('⚠️ 通道被占用：' + store.describe()
      + ' —— 本实例不连接 QQ 网关（控制台与工具仍可用）。'
      + (claim.sameMode ? ' 有另一个 bridge 在跑，先关掉它。' : ' 要切回 bridge：先停插件（enabled:false）再重启。'));
    return { ok: false, store, reason: claim.reason, holder: claim.holder, stop: () => {} };
  }
  log('通道模式：bridge（' + claim.reason + '）');
  const timer = setIntervalFn(() => store.heartbeat('bridge', { pid, note: 'sidecar 通道' }), intervalMs);
  timer?.unref?.();
  return {
    ok: true,
    store,
    stop() {
      try { clearIntervalFn(timer); } catch { /* ignore */ }
      store.release('bridge', { pid });
    },
  };
}
