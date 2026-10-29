#!/usr/bin/env node
// 官方通道发图探针：只做一件事——把一张本地图片真的发到指定 openid。
//
// 为什么单独一个脚本：
//   sendImage 的单元测试只能验证"请求长得对不对"，验证不了
//   "官方到底认不认 file_data / msg_type=7 / file_name 这几个字段"。
//   这条命令就是真机验证的唯一入口。
//
// 用法：
//   node scripts/probe-official-image.mjs --kind group --openid <openid> --file D:\x.png
//   node scripts/probe-official-image.mjs --kind private --openid <openid> --file ... --msgId <id> --msgSeq 1
//
// 不带 --msgId 就是主动消息（会占主动频次；部分机器人没开通主动消息会 403）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfficialQqBot } from '../src/qqbot-official.js';
import { checkImageForOfficial, OFFICIAL_FILE_TYPE } from '../src/official-media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getArg = (n, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const kind = getArg('kind', 'group');
const openid = getArg('openid');
const file = getArg('file');
const msgId = getArg('msgId');
const msgSeq = Number(getArg('msgSeq', '1')) || 1;
const content = getArg('content', '');

if (!openid || !file) {
  console.error('用法：--openid <id> --file <path> [--kind group|private] [--msgId <id>]');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const o = cfg.official || {};
if (!o.appid || !o.secret) { console.error('config.json 里没有 official.appid / official.secret'); process.exit(2); }

const buf = fs.readFileSync(file);
const check = checkImageForOfficial(buf);
console.log(`  图片：${buf.length} 字节，格式=${check.ok ? check.mime : '不支持'}${check.risky ? '（risky：建议转 png）' : ''}`);
if (!check.ok) { console.error('  图片不合格：' + check.reason); process.exit(1); }

const bot = new OfficialQqBot({ appid: o.appid, secret: o.secret, log: (m) => console.log('  ' + m) });

try {
  console.log('  ① 上传中（POST /v2/' + (kind === 'group' ? 'groups' : 'users') + '/{openid}/files）…');
  const up = await bot.uploadMedia(kind, openid, {
    buffer: buf, fileType: OFFICIAL_FILE_TYPE.image, fileName: path.basename(file)
  });
  console.log(`  ✓ 上传成功：file_info 长度=${String(up.fileInfo).length}  ttl=${up.ttl}`);

  console.log('  ② 发送中（msg_type=7）…');
  const send = kind === 'group'
    ? await bot.sendGroupMedia(openid, up.fileInfo, { msgId, msgSeq, content })
    : await bot.sendC2CMedia(openid, up.fileInfo, { msgId, msgSeq, content });
  console.log('  ✓ 发送成功：', JSON.stringify(send).slice(0, 200));
  console.log('\n  真机验证通过 —— 去看群里/单聊里收到图没有。');
} catch (error) {
  console.error('  ✗ 失败：' + (error?.message ?? error));
  process.exitCode = 1;
}