// PID 存活性判断（唯一实现）。
//
// 为什么单独一个模块：通道锁（channel-mode-store）和官方实例锁（instance-lock）
// 都要判断"持有者还活着吗"，两处口径必须一致 —— 否则一个说死了、一个说活着，
// 就会出现"一个实例抢到通道、另一个抢到官方锁"的错位。
//
// 关键规则（0.4.49，外部审查 P2-2）：
//   ESRCH  = 进程不存在        → 已死，可接管
//   EPERM  = 存在但无权发信号  → **活着**，接管就是双实例
//   其它   = 不知道            → 保守当作活着

/**
 * @param {unknown} error
 * @returns {'alive'|'gone'}
 */
export function classifyKillError(error) {
  const code = String(error?.code ?? '');
  if (code === 'ESRCH') return 'gone';
  return 'alive';
}

/**
 * @param {number} pid
 * @param {(pid: number, signal: number) => boolean} [killFn]
 * @returns {boolean}
 */
export function isPidAlive(pid, killFn) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  const kill = typeof killFn === 'function' ? killFn : process.kill.bind(process);
  try { kill(n, 0); return true; }
  catch (error) { return classifyKillError(error) === 'alive'; }
}
