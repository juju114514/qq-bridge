// sidecar 接线的辅助（N2）：把"读 token / 读版本 / 已读水位 / IO 实例"从 bridge.js 挪出来。
//
// 为什么单独一个文件：bridge.js 有行数棘轮（单次改动 +50 行以内），
// 而这段纯胶水代码放在 bridge 里既撑爆棘轮、也没法离线测。

import { createSidecarIo } from './plugin-sidecar-io.js';

export function createPluginBridgeWiring({
  fs, path, stateDir, root,
  log = () => {},
  getSocialV2State = () => ({}),
  saveSocialV2State = () => {},
} = {}) {
  let ioInstance = null;

  const io = () => (ioInstance ??= createSidecarIo({ fs, path, stateDir, log }));

  /** 插件认证 token：优先 state/plugin-token，没有就返回 null（调用方回退 console token）。 */
  function pluginToken() {
    try {
      const file = path.join(stateDir, 'plugin-token');
      if (fs.existsSync(file)) {
        const v = fs.readFileSync(file, 'utf8').trim();
        if (v) return v;
      }
    } catch { /* 读不到就回退 */ }
    return null;
  }

  function version() {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
    } catch { return '0.0.0'; }
  }

  /** read.mark 意图：更新会话已读水位（不依赖 QQ 网关）。 */
  async function markRead(key, throughSeq) {
    const st = getSocialV2State(key) ?? {};
    st.lastMarkReadSeq = Number(throughSeq) || 0;
    st.lastMarkReadAt = Date.now();
    saveSocialV2State();
    log(`[sidecar] 已读水位：${key} → ${st.lastMarkReadSeq}`);
  }

  return { io, pluginToken, version, markRead };
}