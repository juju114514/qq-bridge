/**
 * OneBot 通道：把"收消息 / 发消息"这两件纯粹的网络活集中在一处。
 *
 * 复用 src/onebot-ws.js（403 行，已经替代了 @snowluma/sdk）。
 * 这里不写任何判定逻辑 —— 判定在 inbound.js，喂给 Agent 在 agent-driver.js。
 */

export function createChannel({
  Client,
  clientOptions,
  log = () => {},
  onInbound = () => {},
} = {}) {
  let client = null;
  let started = false;

  function send(chatKey, text) {
    const body = String(text ?? '');
    // 空文本先返回：这不是"没启动"，而是根本不该发（QQ 会回参数错误，白刷日志）
    if (!body.trim()) return null;
    if (!client) throw new Error('通道未启动：先 start()');
    const [kind, id] = String(chatKey).split(':');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_message';
    const params = kind === 'group'
      ? { group_id: Number(id), message: body }
      : { user_id: Number(id), message: body };
    return client.action(action, params);
  }

  async function start() {
    if (started) return;
    client = new Client(clientOptions);
    client.on('event', (event) => {
      try { onInbound(event); } catch (e) { log('入站处理抛错（已吞掉，避免断链）：' + (e?.message ?? e)); }
    });
    client.on('open', () => log('OneBot 已连接：' + clientOptions.url));
    client.on('close', () => log('OneBot 断开（会自动重连）'));
    client.on('error', (e) => log('OneBot 错误：' + (e?.message ?? e)));
    await client.connect();
    started = true;
  }

  function close() {
    started = false;
    try { client?.close?.(1000, 'plugin dispose'); } catch { /* 卸载失败不影响宿主 */ }
    client = null;
  }

  return { start, send, close, get client() { return client; }, get started() { return started; } };
}