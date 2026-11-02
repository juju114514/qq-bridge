// 官方通道存活探测（0.4.130）
//
// 为什么需要：0.4.129 之前，连接被服务端 op7/4009 关掉后我们**不重连也不报警**，
// 控制台一直显示 connected —— 用户以为在跑，实际消息一条都收不到。
//
// 这里只做一件事：记录「最后一次收到任何服务端数据的时间」，
// 超过 staleMs 没动静就判定为 stale，让控制台能亮红条。
import { EventEmitter } from 'node:events';

/**
 * @param {{staleMs?:number, now?:()=>number}} opts
 */
export function createLivenessTracker({ staleMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let lastAt = 0;
  let connected = false;
  let ready = false;
  let closedAt = 0;

  return {
    /** 收到任何服务端帧（含心跳 ACK） */
    touch() { lastAt = now(); },
    /** 连接建立 */
    onOpen() { connected = true; lastAt = now(); closedAt = 0; },
    /** 连接关闭 */
    onClose() { connected = false; ready = false; closedAt = now(); },
    /** READY / RESUMED */
    onReady() { ready = true; this.touch(); },
    /** 当前快照：给控制台/健康检查用 */
    snapshot() {
      const t = now();
      const ageMs = lastAt ? t - lastAt : null;
      const stale = connected && ready && ageMs !== null && ageMs > staleMs;
      return {
        connected,
        ready,
        // stale：连着但很久没数据 —— 这才是「看起来在跑，其实死了」的信号
        stale,
        ageMs,
        lastEventAt: lastAt || null,
        closedAt: closedAt || null,
        staleMs
      };
    }
  };
}

/**
 * 把快照翻成一句人话 + 一个等级（ok / warn / error）。
 * @param {ReturnType<typeof createLivenessTracker>['snapshot'] extends never ? never : any} snap
 */
export function describeLiveness(snap) {
  if (!snap) return { level: 'warn', text: '官方通道未启用' };
  if (!snap.connected && !snap.ready) {
    return { level: 'error', text: '官方通道已断开（正在重连）' };
  }
  if (snap.connected && !snap.ready) {
    return { level: 'warn', text: '官方通道连接中，还没鉴权成功' };
  }
  if (snap.stale) {
    const min = Math.round((snap.ageMs || 0) / 60000);
    return { level: 'error', text: `官方通道 ${min} 分钟没有数据（疑似假连接）` };
  }
  return { level: 'ok', text: '官方通道正常' };
}
