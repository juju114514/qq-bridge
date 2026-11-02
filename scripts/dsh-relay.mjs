#!/usr/bin/env node
// 启动家庭中继（P3）：把家里的 DSH 端口转给手机用
//
//   node scripts/dsh-relay.mjs                      # 默认 0.0.0.0:58784 → 127.0.0.1:58783
//   node scripts/dsh-relay.mjs --port 58784 --target-port 58783
//   node scripts/dsh-relay.mjs --allow-remote false  # 默认就是只允许内网
//
// 手机侧（Termux）只需要把 config.json 改成：
//   "agent": { "mode": "auto", "auto": { "dshBaseUrl": "http://<PC 的局域网 IP>:58784" } }
import { createRelay, isPrivateAddress } from '../src/dsh-relay.js';
import os from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', 58784));
const targetPort = Number(arg('target-port', 58783));
const targetHost = arg('target-host', '127.0.0.1');
const host = arg('host', '0.0.0.0');
const allowRemote = String(arg('allow-remote', 'false')) === 'true';

const relay = createRelay({
  target: { host: targetHost, port: targetPort },
  listen: { host, port },
  allowRemote,
  log: (m) => console.log(`${new Date().toLocaleTimeString('zh-CN')} ${m}`)
});

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((x) => x && x.family === 'IPv4' && !x.internal && isPrivateAddress(x.address))
  .map((x) => x.address);

await relay.start();
console.log('  家庭中继已启动');
console.log(`  本机地址: ${lanIps.length ? lanIps.join(', ') : '（没有内网 IP）'}`);
console.log(`  手机侧填: http://${lanIps[0] || '<PC-IP>'}:${port}`);
console.log('  只允许内网来源；不要映射到公网端口。Ctrl+C 退出。');

const bye = async () => {
  const s = relay.stats();
  console.log(`  统计：连接 ${s.connections} / 拒绝 ${s.rejected} / 下行 ${(s.bytesIn / 1024).toFixed(1)}KB`);
  await relay.stop();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
