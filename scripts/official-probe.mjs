#!/usr/bin/env node
// QQ 官方机器人「端到端验证」：票据 → gateway → 收事件 → 回一条。
//
// 为什么要有它：官方通道与 SnowLuma 完全是两套协议，"能不能用"只能实测，不能靠猜。
// 这个脚本把四步一次跑完并把结论摊开：
//   ① 换 access_token（AppID + AppSecret）
//   ② 拉 gateway
//   ③ 连 WebSocket 收事件（群 @ / 群全量 / 单聊）
//   ④ 收到第一条就**被动回复**一次（带 msg_id，证明回复链路通）
//
// 用法：
//   node scripts/official-probe.mjs                     # 监听 90 秒
//   node scripts/official-probe.mjs --seconds 180
//   node scripts/official-probe.mjs --send-test <group_openid>   # 额外测一次主动消息
//   node scripts/official-probe.mjs --creds D:\QQBot\temp\official.json
//
// 凭证文件（默认 state/official.json，已被 .gitignore 排除）：
//   { "appid": "102xxxxx", "secret": "xxxx", "sandbox": false }
//
// 退出码：0 = 票据+gateway 通（是否收到事件见输出）；1 = 票据/gateway 失败；2 = 环境问题

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfficialQqBot, toBridgeEvent } from '../src/qqbot-official.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ''; };
const SECONDS = Number(argOf('--seconds')) || 90;
const SEND_TEST = argOf('--send-test');
const credsPath = argOf('--creds') || path.join(ROOT, 'state', 'official.json');

const mask = (s, keep = 5) => {
  const v = String(s ?? '');
  if (v.length <= keep * 2) return '*'.repeat(Math.max(1, v.length));
  return `${v.slice(0, keep)}…${v.slice(-3)}（长 ${v.length}）`;
};

if (!fs.existsSync(credsPath)) {
  console.error(`  ✗ 缺凭证文件：${credsPath}`);
  console.error('    内容：{ "appid": "...", "secret": "...", "sandbox": false }');
  process.exit(2);
}
let cred = {};
try {
  cred = JSON.parse(fs.readFileSync(credsPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`  ✗ 凭证文件不是合法 JSON：${error.message}`);
  process.exit(2);
}
const appid = String(cred.appid ?? cred.appId ?? '').trim();
const secret = String(cred.secret ?? cred.clientSecret ?? cred.appSecret ?? '').trim();
if (!appid || !secret) { console.error('  ✗ 缺 appid 或 secret'); process.exit(2); }

const bot = new OfficialQqBot({
  appid,
  secret,
  sandbox: cred.sandbox === true,
  log: (m) => console.log(`  ${m}`)
});
console.log(`  appid=${appid}  secret=${mask(secret, 3)}  sandbox=${cred.sandbox === true}`);
console.log(`  API=${bot.api}\n`);

try {
  const token = await bot.accessToken(true);
  console.log(`  [1/4] ✓ access_token 拿到（${mask(token, 5)}，有效期至 ${new Date(bot.tokenExpiresAt).toLocaleTimeString()}）`);
  const url = await bot.gateway();
  console.log(`  [2/4] ✓ gateway：${url}`);
} catch (error) {
  console.error(`  ✗ ${error.message}`);
  process.exit(1);
}

if (SEND_TEST) {
  console.log(`\n  [3/4] 主动发一条到 group_openid=${mask(SEND_TEST)} …`);
  try {
    const r = await bot.sendGroupText(SEND_TEST, '【qq-bridge 自测】这条来自 official-probe.mjs，收到请忽略。');
    console.log(`  ✓ 已发送 id=${r?.id ?? '?'}`);
  } catch (error) {
    console.log(`  ✗ ${error.message}`);
  }
} else {
  console.log('\n  [3/4] 跳过主动发送（要测加 --send-test <group_openid>）');
}

console.log(`\n  [4/4] 监听事件 ${SECONDS} 秒（现在去群里 @ 机器人一次）…`);
let received = 0;
let replied = false;
let closed = false;

const shutdown = (code) => {
  if (closed) return;
  closed = true;
  clearTimeout(timer);
  bot.close();
  console.log(`\n  ── 结果：收到 ${received} 个消息事件${replied ? '，并成功被动回复 1 条' : '（未回复）'}`);
  if (received === 0) {
    console.log('     没收到事件？检查：机器人是否已加群 / 群里是否 @ 了它 / 群主是否开了「接收全量消息」/ 是否发到了别的群');
  }
  process.exit(code);
};
const timer = setTimeout(() => shutdown(0), SECONDS * 1000);

await bot.connect({
  onReady: () => console.log('  ✓ 鉴权成功（READY）'),
  onError: (e) => console.error(`  ✗ ${e.message}`),
  onEvent: async (event) => {
    received += 1;
    const tag = event.kind === 'group' ? (event.atBot ? '群@' : '群全量') : '单聊';
    console.log(`  · [${tag}] id=${mask(event.id)} 作者=${event.authorName} 内容「${event.text.slice(0, 60)}」`);
    if (replied) return;
    try {
      await bot.reply(event, `【official-probe】收到：${event.text.slice(0, 40)}`);
      replied = true;
      console.log('    ✓ 被动回复成功（msg_id 链路通）');
    } catch (error) {
      console.log(`    ✗ 被动回复失败：${error.message}`);
    }
  }
});
