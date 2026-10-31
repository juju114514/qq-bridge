// DSH 端口自动发现（src/dsh-port.js）的契约测试。
//
// 为什么必须有这条链路：**DSH 每次重启都换一个随机回环端口**（实测 54694 → 65452 → 50075）。
// 以前只能靠人把新端口抄进 config.json，而 QQ 侧的症状只是「消息已排队」，指不到这里。
//
// 这里只测**离线可测**的部分：候选端口顺序、HTTP 探活的判定、平台闸门、以及接线。
// 真的去问系统"DSH 在听哪个端口"属于活体测试（CI 里没有 DSH），不放在这里。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mod = await import(new URL('../src/dsh-port.js', import.meta.url).href);
const { canDiscoverPorts, probeHttpPort, discoverDshBaseUrl, resetDshPortCache } = mod;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 1. 平台闸门 ──────────────────────────────────────────────────────────
await check('canDiscoverPorts：只有 Windows 能问系统端口（其它平台返回 false，不猜）', () => {
  assert.equal(canDiscoverPorts(), process.platform === 'win32');
});

// ── 2. HTTP 探活：真起一个回环 socket ────────────────────────────────────
await check('probeHttpPort：有 HTTP 服务的端口返回 true，关着的端口返回 false', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const alive = await probeHttpPort(port, { timeoutMs: 3000 });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(alive, true, '起了 HTTP 服务却判死');
  const deadPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  assert.equal(await probeHttpPort(deadPort, { timeoutMs: 800 }), false, '关掉的端口却判活');
});

// ── 3. 候选顺序 + 找不到时不编造 ─────────────────────────────────────────
await check('discoverDshBaseUrl：优先已配置端口；全都探不通时返回 null（不瞎猜）', async () => {
  resetDshPortCache();
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const livePort = server.address().port;

  // 起点是一个死端口，真实服务在 livePort → 应该能发现它
  // env: {} —— 隔离 DSH_WEB_URL：真机跑测试时它指向真实 DSH，会干扰"全探不通"的断言
  const found = await discoverDshBaseUrl({
    preferred: 'http://127.0.0.1:1', extraPorts: [livePort], useCache: false, skipSystemPorts: true, env: {}
  });
  assert.equal(found.baseUrl, `http://127.0.0.1:${livePort}`, `没发现 live 端口，实际 ${found.baseUrl}`);
  assert.equal(found.source, 'discovered');
  assert.ok(found.candidates.includes(livePort), '候选里应包含额外端口');

  // 全都不通 → null
  const none = await discoverDshBaseUrl({
    preferred: 'http://127.0.0.1:1', extraPorts: [], useCache: false, skipSystemPorts: true,
    timeoutMs: 600, env: {}
  });
  assert.equal(none.baseUrl, null);
  assert.equal(none.source, 'not-found');
  await new Promise((resolve) => server.close(resolve));
});

// ── 4. 接线 ──────────────────────────────────────────────────────────────
await check('bridge：连不上时先自愈 —— 发现→写 config→重建客户端→重试', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /from '\.\/dsh-port\.js'/, '必须导入发现器');
  assert.match(bridge, /let api = new NodeApiClient/, 'api 必须是 let 才能重建');
  assert.match(bridge, /const ensureDshBaseUrl = async/, '要有自愈函数');
  assert.match(bridge, /persistDshBaseUrl\(/, '写回 config 要用只改一个字段的专用函数');
  assert.doesNotMatch(bridge, /persistSnowLumaEndpoint\(path\.join\(ROOT, 'config\.json'\), \{ dshBaseUrl/,
    '不能拿 snowluma 的持久化函数写 dsh 字段（它会静默忽略）');
  assert.match(bridge, /端口漂移/, '日志要写清"端口漂移"这件事');
});

await check('persistDshBaseUrl：只改 dsh.baseUrl、保留 BOM、幂等', () => {
  const bridge = read('src/bridge.js');
  const body = bridge.slice(bridge.indexOf('function persistDshBaseUrl'), bridge.indexOf('function persistDshBaseUrl') + 1400);
  assert.match(body, /hadBom/, '必须记住并保留 BOM 状态');
  assert.match(body, /cfg\.dsh = \{ \.\.\.\(cfg\.dsh \?\? \{\}\), baseUrl: value \}/, '只改这一个字段');
  assert.match(body, /current === value/, '值一样就不写文件（幂等）');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
// 发现器会留下探测用的 socket/定时器；显式退出，避免拖住 test-audit
process.exit(failures ? 1 : 0);
