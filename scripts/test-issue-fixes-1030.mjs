// 三个 issue 的最小回归（#110 缓存 / #114 定时器 / #115 日志）。
//
// 都是"一次瞬时失败 → 永久故障"这类，最难在真机上复现，所以钉在单测里。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const { NodeApiClient } = await import(new URL('../src/dsh-client.js', import.meta.url).href);

await check('#115 日志不再包含 token 片段', async () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const bad = /slice\(0, ?[0-9]\)[^`\n]*token|token[^`\n]*slice\(0, ?[0-9]\)/i.test(src);
  assert.equal(bad, false, 'bridge.js 里不该再出现"打印 token 前几位"的写法');
  const conn = fs.readFileSync(new URL('../src/snowluma-conn.js', import.meta.url), 'utf8');
  assert.equal(/token\.slice\(0, ?[0-9]\)/.test(conn), false);
});

await check('#110 签名密钥读取失败不永久缓存（写好文件后能恢复）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  const prevHome = process.env.DSH_HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.DSH_HOME = home;
  try {
    const client = new NodeApiClient('http://127.0.0.1:1');
    assert.equal(client.browserSessionSecret(), null, '第一次读不到应为 null');

    // 退避窗口内不重试（避免文件系统故障时刷屏）
    assert.equal(client.browserSessionSecret(), null);

    // 模拟"DSH 稍后才写出凭据"：绕过退避直接再读一次
    client._secretMissAt = 0;
    const credDir = home;
    const secret = Buffer.alloc(32, 7).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    fs.writeFileSync(path.join(credDir, '.credentials.yaml'),
      `records:\n  'client-connection/browser-session':\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`);
    const got = client.browserSessionSecret();
    assert.ok(got && got.byteLength === 32, `写出凭据后应能读到，实际 ${got}`);
    assert.ok(client.browserSessionSecret().equals(got), '成功值应被缓存');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check('#114 唤醒接管时会清理限频重试定时器', async () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 断言"清理"出现在 cancelReplyCheckV2(key) 之后（即真正开始一次唤醒的地方）
  const at = src.indexOf('cancelReplyCheckV2(key); // 本次唤醒已接管');
  assert.ok(at > 0, '找不到唤醒接管点');
  const after = src.slice(at, at + 400);
  assert.match(after, /rateLimitRetryTimer/);
  assert.match(after, /clearTimeout/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }