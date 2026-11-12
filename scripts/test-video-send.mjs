// 发视频到 QQ（src/video-send.js）的离线测试：用假 bot，不连真 QQ。
//
// 为什么必须测：这是唯一会「把文件发到别人的群」的代码路径，
// 参数/边界错了就是误发或静默失败。四类边界都要钉住：
//   · 官方通道不支持视频 → 明确报错，不能装作成功
//   · 文件不存在 / 空文件 → 拒绝
//   · key 形态不对 → 拒绝
//   · 正常路径 → 群/私聊分别调用对的方法，且带 video 段

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVideoSender } from '../src/video-send.js';

let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ✓', name); };

const tmpFile = path.join(os.tmpdir(), `qqb-vsend-test-${process.pid}.mp4`);
fs.writeFileSync(tmpFile, Buffer.alloc(2048, 1));

function fakeBot() {
  const calls = [];
  return {
    calls,
    sendGroupMessage: async (id, msg) => { calls.push({ m: 'group', id, msg }); return { message_id: 1 }; },
    sendPrivateMessage: async (id, msg) => { calls.push({ m: 'private', id, msg }); return { message_id: 2 }; }
  };
}

await check('群里发视频：走 sendGroupMessage + video 段', async () => {
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('group:630679184', tmpFile);
  assert.equal(r.ok, true);
  assert.equal(bot.calls.length, 1);
  assert.equal(bot.calls[0].m, 'group');
  assert.equal(bot.calls[0].id, 630679184);
  assert.deepEqual(bot.calls[0].msg[0].type, 'video');
  assert.ok(String(bot.calls[0].msg[0].data.file).includes('qqb-vsend-test'));
});

await check('私聊发视频：走 sendPrivateMessage', async () => {
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('private:123456', tmpFile);
  assert.equal(r.ok, true);
  assert.equal(bot.calls[0].m, 'private');
});

await check('官方通道：明确拒绝，不发', async () => {
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('group:official-ABC', tmpFile);
  assert.equal(r.ok, false);
  assert.match(r.error, /官方通道/);
  assert.equal(bot.calls.length, 0);
});

await check('文件不存在：拒绝', async () => {
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('group:1', path.join(os.tmpdir(), 'no-such-file-xyz.mp4'));
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
  assert.equal(bot.calls.length, 0);
});

await check('key 形态不对：拒绝', async () => {
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  for (const k of ['', 'group', 'abc:1', 'channel:1']) {
    const r = await s.sendVideo(k, tmpFile);
    assert.equal(r.ok, false, k);
  }
  assert.equal(bot.calls.length, 0);
});

await check('空文件：拒绝', async () => {
  const empty = path.join(os.tmpdir(), `qqb-vsend-empty-${process.pid}.mp4`);
  fs.writeFileSync(empty, Buffer.alloc(0));
  const bot = fakeBot();
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('group:1', empty);
  assert.equal(r.ok, false);
  assert.match(r.error, /空文件/);
  fs.rmSync(empty, { force: true });
});

await check('发送抛错时不崩，返回 ok:false', async () => {
  const bot = {
    sendGroupMessage: async () => { throw new Error('onebot boom'); },
    sendPrivateMessage: async () => { throw new Error('onebot boom'); }
  };
  const s = createVideoSender({ bot });
  const r = await s.sendVideo('group:1', tmpFile);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

fs.rmSync(tmpFile, { force: true });
console.log(`\n发视频：${n} 项通过`);
