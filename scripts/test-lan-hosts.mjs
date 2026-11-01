// 局域网 Host 白名单（0.4.109）：私网判定 / 网卡挑选 / 白名单拼装
import assert from 'node:assert/strict';

const m = await import(new URL('../src/lan-hosts.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('私有网段判定：192.168 / 10 / 172.16-31 / 100.64-127（Tailscale）', () => {
  assert.equal(m.isPrivateIPv4('192.168.1.2'), true);
  assert.equal(m.isPrivateIPv4('10.0.0.5'), true);
  assert.equal(m.isPrivateIPv4('172.16.3.4'), true);
  assert.equal(m.isPrivateIPv4('172.31.255.1'), true);
  assert.equal(m.isPrivateIPv4('100.101.102.103'), true);
  assert.equal(m.isPrivateIPv4('172.32.0.1'), false);
  assert.equal(m.isPrivateIPv4('8.8.8.8'), false);
  assert.equal(m.isPrivateIPv4('not-an-ip'), false);
});

check('从网卡里挑私有 IPv4：跳过回环与 IPv6', () => {
  const ifs = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth: [{ address: '192.168.1.2', family: 'IPv4', internal: false }],
    v6: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    veth: [{ address: '172.30.16.1', family: 4, internal: false }]
  };
  assert.deepEqual(m.privateIPv4s(ifs), ['192.168.1.2', '172.30.16.1']);
});

check('白名单：回环 + 私有 IP + 额外，都带端口、去重、小写', () => {
  const list = m.hostAllowList({
    port: 3100,
    interfaces: { eth: [{ address: '192.168.1.2', family: 'IPv4', internal: false }] },
    extra: ['My-PC:3100', 'example.local']
  });
  assert.ok(list.includes('127.0.0.1:3100'));
  assert.ok(list.includes('localhost:3100'));
  assert.ok(list.includes('192.168.1.2:3100'));
  assert.ok(list.includes('my-pc:3100'), '额外项要小写');
  assert.ok(list.includes('example.local:3100'), '不带端口的要补端口');
  assert.equal(new Set(list).size, list.length, '不能重复');
});

check('IPv6 回环：[::1]:3100 形式', () => {
  const list = m.hostAllowList({ port: 3100 });
  assert.ok(list.includes('[::1]:3100'));
});

check('脏数据不炸', () => {
  assert.deepEqual(m.privateIPv4s(null), []);
  assert.deepEqual(m.privateIPv4s({ a: null }), []);
  assert.ok(Array.isArray(m.hostAllowList({ port: 0, extra: [null, '', 42] })));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
