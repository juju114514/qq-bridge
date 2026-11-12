// 把下载好的视频发到 QQ（群里/私聊）。
//
// 为什么单独一个模块：bridge.js 有 +50 行/次的体积闸门，而且 sendToQQ 只处理文本
// （它会 splitForQQ 分段、脱敏、走 sendChain）。视频是**一条消息段**，不能走那条链。
//
// 边界：
//   · 官方通道（官方机器人 API）不支持视频段 —— 直接返回 unsupported，不装作成功
//   · 只接受本地已存在的文件（防止被注入任意路径）
//   · 走 OneBot 的 video 段：`{ type: 'video', data: { file } }`

import fs from 'node:fs';

/** 官方通道 id 形如 official-XXXX（见 bridge 的 isOfficialId）。 */
const isOfficialId = (id) => /^official-/i.test(String(id ?? ''));

/**
 * @param {{bot: {sendGroupMessage: Function, sendPrivateMessage: Function},
 *          withTimeout?: Function, timeoutMs?: number, log?: Function}} deps
 */
export function createVideoSender({ bot, withTimeout = (p) => p, timeoutMs = 60000, log = () => {} } = {}) {
  /**
   * @param {string} key group:<id> / private:<id>
   * @param {string} filePath 本地视频文件路径
   * @returns {Promise<{ok:boolean, error?:string, bytes?:number}>}
   */
  async function sendVideo(key, filePath) {
    const rawKey = String(key ?? '');
    const idx = rawKey.indexOf(':');
    if (idx < 0) return { ok: false, error: 'bad-key' };
    const kind = rawKey.slice(0, idx);
    const id = rawKey.slice(idx + 1);
    if (kind !== 'group' && kind !== 'private') return { ok: false, error: 'bad-key' };
    if (isOfficialId(id)) return { ok: false, error: '官方通道不支持发视频，需要 OneBot 通道' };

    const file = String(filePath ?? '');
    if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { /* ignore */ }
    if (!bytes) return { ok: false, error: '空文件' };

    // OneBot v11：video 段可以给本地路径或 file:// URI，交给实现方处理
    const segment = [{ type: 'video', data: { file: `file://${file.replace(/\\/g, '/')}` } }];
    try {
      if (kind === 'private') {
        await withTimeout(bot.sendPrivateMessage(Number(id), segment), timeoutMs, 'QQ发视频 私聊');
      } else {
        await withTimeout(bot.sendGroupMessage(Number(id), segment), timeoutMs, 'QQ发视频 群');
      }
      log(`[video-out] 已发送视频 → ${rawKey}（${(bytes / 1024 / 1024).toFixed(1)}MB）`);
      return { ok: true, bytes };
    } catch (error) {
      const msg = String(error?.message ?? error);
      log(`[video-out] 发送失败 ${rawKey}：${msg.slice(0, 120)}`);
      return { ok: false, error: msg.slice(0, 200) };
    }
  }

  return { sendVideo };
}
