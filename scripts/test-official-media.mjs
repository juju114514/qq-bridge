// 官方通道富媒体：请求构造与闸门（离线，不连 QQ）
//
// 为什么值得单独测：官方发多媒体是**两步**且字段名极易记错
//   （file_type / srv_send_msg / file_data / media.file_info / msg_type=7）。
// 一旦写错，线上表现是"上传成功但发送 400"，很难从日志看出是哪一步。

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const m = await import(new URL('../src/official-media.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('file_type 常量：图片 1 / 视频 2 / 语音 3 / 文件 4', () => {
  assert.equal(m.OFFICIAL_FILE_TYPE.image, 1);
  assert.equal(m.OFFICIAL_FILE_TYPE.voice, 3);
  assert.equal(m.OFFICIAL_MSG_TYPE_MEDIA, 7);
});

check('sniffImageMime：png / jpeg / gif / webp 都认', () => {
  assert.equal(m.sniffImageMime(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), 'image/png');
  assert.equal(m.sniffImageMime(Buffer.from([0xff,0xd8,0xff,0xe0])), 'image/jpeg');
  assert.equal(m.sniffImageMime(Buffer.from('GIF89a', 'latin1')), 'image/gif');
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  assert.equal(m.sniffImageMime(webp), 'image/webp');
  assert.equal(m.sniffImageMime(Buffer.from('not an image')), '');
});

check('buildUploadBody：buffer / url 二选一，同时给会报错', () => {
  const b1 = m.buildUploadBody({ fileType: 1, buffer: Buffer.from('abc'), fileName: 'a.png' });
  assert.equal(b1.file_type, 1);
  assert.equal(b1.srv_send_msg, false);
  assert.equal(b1.file_name, 'a.png', '二进制上传必须带 file_name');
  assert.equal(typeof b1.file_data, 'string');
  assert.throws(() => m.buildUploadBody({ fileType: 1, buffer: Buffer.from('abc') }), /fileName/);

  const b2 = m.buildUploadBody({ fileType: 1, url: 'https://x/y.png' });
  assert.equal(b2.url, 'https://x/y.png');
  assert.equal(b2.file_data, undefined);

  assert.throws(() => m.buildUploadBody({ fileType: 1 }), /二选一/);
  assert.throws(() => m.buildUploadBody({ fileType: 1, buffer: Buffer.from('a'), fileName: 'a.png', url: 'https://x' }), /二选一/);
  assert.throws(() => m.buildUploadBody({ fileType: 99, url: 'https://x' }), /file_type/);
});

check('buildMediaMessage：msg_type=7 + media.file_info，被动回复带 msg_id/msg_seq', () => {
  const b = m.buildMediaMessage({ fileInfo: 'FI', msgId: 'M1', msgSeq: 3 });
  assert.equal(b.msg_type, 7);
  assert.equal(b.media.file_info, 'FI');
  assert.equal(b.msg_id, 'M1');
  assert.equal(b.msg_seq, 3);

  const active = m.buildMediaMessage({ fileInfo: 'FI' });
  assert.equal(active.msg_id, undefined, '主动消息不该带 msg_id');

  const withText = m.buildMediaMessage({ fileInfo: 'FI', content: '看图' });
  assert.equal(withText.content, '看图');

  assert.throws(() => m.buildMediaMessage({}), /fileInfo/);
});

check('checkImageForOfficial：空 / 超大 / 非法格式都拒绝并给原因', () => {
  assert.equal(m.checkImageForOfficial(Buffer.alloc(0)).reason, 'empty');
  assert.match(m.checkImageForOfficial(Buffer.alloc(10), { maxBytes: 5 }).reason, /too-large/);
  assert.equal(m.checkImageForOfficial(Buffer.from('nope')).reason, 'unsupported-format');
  const ok = m.checkImageForOfficial(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, 'image/png');
  assert.equal(ok.risky, false);
  const gif = m.checkImageForOfficial(Buffer.from('GIF89a', 'latin1'));
  assert.equal(gif.ok, true);
  assert.equal(gif.risky, true, 'gif 必须标记为有风险（官方文档自相矛盾）');
});

check('pickFileInfo：兼容 file_info / fileInfo / data.file_info 三种位置', () => {
  assert.equal(m.pickFileInfo({ file_info: 'A' }), 'A');
  assert.equal(m.pickFileInfo({ fileInfo: 'B' }), 'B');
  assert.equal(m.pickFileInfo({ data: { file_info: 'C' } }), 'C');
  assert.equal(m.pickFileInfo(null), '');
});

check('接线：官方 client 真的有 uploadMedia / sendGroupMedia / sendC2CMedia', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/qqbot-official.js', import.meta.url), 'utf8');
  assert.match(src, /async uploadMedia\(/, '缺 uploadMedia');
  assert.match(src, /async sendGroupMedia\(/, '缺 sendGroupMedia');
  assert.match(src, /async sendC2CMedia\(/, '缺 sendC2CMedia');
  assert.match(src, /\/v2\/' \+ seg \+ '\/' \+ encodeURIComponent\(openid\) \+ '\/files'/, '上传路径拼错');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }