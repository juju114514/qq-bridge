// 通道模式闸的落盘部分（N3）：认领 / 心跳 / 释放 + epoch（fencing token）。
//
// 文件：
//   state/channel-mode.json      当前持有者（status/mode/pid/epoch/at）
//   state/channel-mode-epoch     单调递增的 epoch 水位（**永不删除**）
//   state/channel-mode.lock      跨进程互斥（短生命周期）
//
// 为什么需要 epoch 水位文件：
//   epoch 是 fencing token —— 旧任务带着旧 epoch 回来后，必须永远无法再「碰巧匹配」。
//   如果只把 epoch 存在 channel-mode.json 里，释放时删文件、下次认领从 1 开始，
//   那么「崩溃前 epoch=1 的旧任务」和「重启后 epoch=1 的新持有者」就会撞车。
//   所以水位单独落盘、只增不减。
import { atomicWriteJson } from '../atomic-write.js';
import { claimMode, shouldRelease, describeMode, assertEpochCurrent, StaleEpochError, DEFAULT_TTL_MS, SCHEMA_VERSION } from './channel-mode.js';

export { StaleEpochError };

const LOCK_STALE_MS = 5_000;   // 锁超过 5s 视为遗留（进程崩了）
const LOCK_RETRY = 40;         // 40 × 5ms = 200ms 上限
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };

export function createChannelModeStore({ fs, path, stateDir, ttlMs = DEFAULT_TTL_MS } = {}) {
  const file = path.join(stateDir, 'channel-mode.json');
  const epochFile = path.join(stateDir, 'channel-mode-epoch');
  const lockFile = path.join(stateDir, 'channel-mode.lock');

  function readRaw(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  }

  function read() {
    const raw = readRaw(file);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      return j && typeof j === 'object' ? j : null;
    } catch { return null; }
  }

  /** epoch 水位：只增不减；文件丢失时按 0 处理（会被下一次 claim 修正）。 */
  function readEpochFloor() {
    const raw = readRaw(epochFile);
    if (!raw) return 0;
    try {
      const j = JSON.parse(raw);
      return Number(j?.epoch) || 0;
    } catch { return 0; }
  }

  function writeEpochFloor(epoch) {
    const cur = readEpochFloor();
    if (epoch <= cur) return true;
    try {
      atomicWriteJson(epochFile, { schemaVersion: SCHEMA_VERSION, epoch });
      return true;
    } catch { return false; }
  }

  // 原子写交给 src/atomic-write.js（全仓唯一实现，见该文件头注释）
  function atomicWrite(target, content) {
    try {
      atomicWriteJson(target, JSON.parse(content));
      return true;
    } catch { return false; }
  }

  /** 跨进程互斥：'wx' 创建；残留锁按 mtime 判定后抢占。 */
  function withLock(fn) {
    fs.mkdirSync(stateDir, { recursive: true });
    for (let i = 0; i < LOCK_RETRY; i += 1) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        try {
          return fn();
        } finally {
          try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') return null; // 真实错误：交给调用方
        // 残留锁？按 mtime 判定
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
            continue;
          }
        } catch { /* 锁刚消失，重试 */ }
        sleepSync(5);
      }
    }
    return null;
  }

  /** 尝试认领；失败时返回持有者信息，调用方负责降级。 */
  function claim(mode, { pid = process.pid, note = '' } = {}) {
    return withLock(() => {
      const current = read();
      const r = claimMode({ current, mode, pid, ttlMs, note, floorEpoch: readEpochFloor() });
      if (!r.ok) return r;
      const epoch = Number(r.record.epoch) || 0;
      // 先抬水位再写状态：即使两步之间崩溃，水位只会更高（fencing 仍安全）
      writeEpochFloor(epoch);
      if (!atomicWrite(file, JSON.stringify(r.record, null, 2) + '\n')) {
        return { ok: false, reason: 'write-failed' };
      }
      return r;
    }) ?? { ok: false, reason: 'lock-timeout' };
  }

  /** 心跳续期：只有自己还持有时才写，避免把别人的认领覆盖成自己的。 */
  function heartbeat(mode, { pid = process.pid, note = '' } = {}) {
    return withLock(() => {
      const current = read();
      if (!current) return false;
      if (!shouldRelease(current, { mode, pid })) return false;
      // 续期保持 epoch 不变（不换主人）
      const next = { ...current, schemaVersion: SCHEMA_VERSION, status: 'active', at: Date.now(), note };
      return atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
    }) ?? false;
  }

  /** 释放：文件保留为 status=released（epoch 不丢），水位不动。 */
  function release(mode, { pid = process.pid } = {}) {
    return withLock(() => {
      const current = read();
      if (!current) return false;
      if (!shouldRelease(current, { mode, pid })) return false;
      const next = { ...current, schemaVersion: SCHEMA_VERSION, status: 'released', at: Date.now() };
      // 保留 epoch，删掉 pid：既表达"没人持有"，又不让 epoch 回退
      const rec = { ...next };
      delete rec.pid;
      return atomicWrite(file, JSON.stringify(rec, null, 2) + '\n');
    }) ?? false;
  }

  /** 副作用边界守卫：读一次盘，校验 status/mode/epoch；不符抛 StaleEpochError。 */
  function assertCurrent({ mode, epoch } = {}) {
    return assertEpochCurrent(read(), { mode, epoch });
  }

  return {
    read, claim, heartbeat, release, assertCurrent,
    epochFloor: readEpochFloor,
    describe: () => describeMode(read()),
    file, epochFile, lockFile,
  };
}

/**
 * 给常驻进程用的封装：开局认领 → 定时心跳 → 退出释放。
 * @returns {{ ok: boolean, store: object, stop: () => void, reason?: string, holder?: object, epoch?: number }}
 */
export function startBridgeChannelGuard({
  fs, path, stateDir, pid = process.pid, log = () => {},
  intervalMs = 20_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  enabled = true,
} = {}) {
  const store = createChannelModeStore({ fs, path, stateDir });
  if (!enabled) {
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
      log(`通道持有者 pid ${holderPid} 已退出，接管通道`);
      // 删掉残留认领再抢：epoch 水位在另一个文件里，不会因为删文件而回退
      try { fs.rmSync(store.file, { force: true }); } catch { /* ignore */ }
      claim = store.claim('bridge', { pid, note: '接管（旧持有者已退出）' });
    }
  }
  if (!claim.ok) {
    log('⚠️ 通道被占用：' + store.describe()
      + ' —— 本实例不连接 QQ 网关（控制台与工具仍可用）。'
      + (claim.sameMode ? ' 有另一个 bridge 在跑，先关掉它。' : ' 要切回 bridge：先停插件（enabled:false）再重启。'));
    return { ok: false, store, reason: claim.reason, holder: claim.holder, stop: () => {} };
  }
  const epoch = Number(claim.record?.epoch) || 0;
  log(`通道模式：bridge（${claim.reason}，epoch ${epoch}）`);
  const timer = setIntervalFn(() => store.heartbeat('bridge', { pid, note: 'sidecar 通道' }), intervalMs);
  timer?.unref?.();
  return {
    ok: true,
    store,
    epoch,
    stop() {
      try { clearIntervalFn(timer); } catch { /* ignore */ }
      store.release('bridge', { pid });
    },
  };
}
