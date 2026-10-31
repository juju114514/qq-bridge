// 健康状态聚合（0.4.41）。
//
// 关键区分（呼应真机排查的痛点）：
//   · process  —— 进程还活着吗
//   · channel  —— 谁拥有 QQ 通道（mode/epoch/owner），与连接状态无关
//   · services —— 每条外部连接各自的状态（dsh / snowluma / official / console）
//
// 状态取值统一为：starting | connected | reconnecting | degraded | stopped | failed
// live = 进程在跑；ready = 具备"收消息并处理"的条件（通道持有 + DSH + 对应通道连接）
const STATES = Object.freeze(['starting', 'connected', 'reconnecting', 'degraded', 'stopped', 'failed']);

export function createHealthState({ version = '', buildId = '', sourceCommit = '', ownerId = '', pid = process.pid, startedAt = Date.now() } = {}) {
  /** @type {Record<string, string>} */
  const services = { dsh: 'starting', snowluma: 'starting', official: 'stopped', console: 'starting' };
  let channel = { mode: null, epoch: null, status: 'starting' };
  let ownerIdValue = ownerId;
  let lastReason = '';

  function set(service, state, reason = '') {
    if (!SERVICES_HAS(service)) return false;
    if (!STATES.includes(state)) return false;
    if (services[service] === state && (!reason || reason === lastReason)) return false;
    services[service] = state;
    lastReason = reason || lastReason;
    return true;
  }

  function SERVICES_HAS(name) { return Object.prototype.hasOwnProperty.call(services, name); }

  function setChannel(next = {}) {
    channel = { ...channel, ...next };
  }

  /** live：进程在跑（这个函数被调用就说明进程在跑）；ready：能收消息。 */
  function snapshot() {
    const channelOwned = channel.status === 'active' && (channel.mode === 'bridge' || channel.mode === 'plugin');
    // 只有"持有通道"的那条链路才需要连接；另一条连接着也只是 standby
    const activeTransport = channel.mode === 'official' ? null : (channel.mode === 'plugin' ? null : 'snowluma');
    const transportReady = activeTransport ? services[activeTransport] === 'connected' : true;
    const ready = channelOwned && services.dsh === 'connected' && transportReady;
    return {
      ok: true,
      version,
      buildId,
      sourceCommit,
      process: { status: 'running', pid, ownerId: ownerIdValue, uptimeMs: Date.now() - startedAt },
      channel: { ...channel },
      services: { ...services },
      live: true,
      ready,
    };
  }

  /** guard 创建后才知道自己的 ownerId，所以允许后置设置 */
  function setOwnerId(id) { ownerIdValue = String(id ?? ''); }

  return { set, setChannel, setOwnerId, snapshot, services, get channel() { return channel; } };
}

export { STATES };
