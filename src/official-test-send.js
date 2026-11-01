// 官方 markdown 测试发送（0.4.116）
//
// 从 bridge 里抽出来：bridge 已经 1 万行，再塞一段会话查找逻辑就顶到体积上限。
// 职责很窄：找一个目标会话（没给就用最近一条入站），强制走 markdown 发一条。
import fs from 'node:fs';

/**
 * @param {{transport:object, stateDir:string, path:any}} deps
 * @returns {(args:{kind?:string, openid?:string, markdown:string}) => Promise<object>}
 */
export function createOfficialTestSend({ transport, stateDir, path }) {
  return async function officialTestSend({ kind, openid, markdown }) {
    if (!transport) throw new Error('官方通道未启用');
    let target = String(openid || '').trim();
    let k = kind === 'private' ? 'private' : 'group';
    if (!target) {
      try {
        const raw = fs.readFileSync(path.join(stateDir, 'official-inbound.json'), 'utf8').trim().split(/\n/).pop();
        const rec = JSON.parse(raw);
        target = String(rec.openid || '');
        k = rec.kind === 'private' ? 'private' : 'group';
      } catch {
        throw new Error('没有最近入站记录，请手动填 openid');
      }
    }
    if (!target) throw new Error('openid 为空');
    const r = await transport.sendText(k, target, markdown, { markdown: true, forceMarkdown: true });
    return { kind: k, openid: target, result: r ?? {} };
  };
}
