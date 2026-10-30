// 配置校验：脏环境下的端口/主机/未知段。
// 起因：sandbox 里把 consolePort 写成 "abc" / 99999 / -1，桥接照常启动，
// 但控制台 listen 出 `EACCES: permission denied abc` —— 打不开页面还查不出原因。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createConfigLoader } = await import(new URL('../src/config.js', import.meta.url).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cfg-'));
let seq = 0;
function load(obj) {
  const p = path.join(tmp, `config-${++seq}.json`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const loader = createConfigLoader({
    readJsonSafe: (file, fallback) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
    },
    normalizeOwnerQQ: (v) => v,
    normalizeIdList: (v) => (Array.isArray(v) ? v : []),
    discoverDshLaunchToken: () => '',
    normalizeReasoningEffort: (v) => v ?? 'max',
    REASONING_EFFORT_DEFAULT: 'max',
    log: () => {},
    applyRoleInjectLimit: () => {},
    setRoleInjectMaxChars: () => {}
  });
  return loader(p);
}

const results = [];
function check(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
}

check('顶层不是对象 → 明确报"配置格式错误"', () => {
  for (const bad of ['null', '[]', '"x"']) {
    assert.throws(() => load(bad), /配置格式错误/);
  }
});

check('consolePort 缺省 → 3100', () => {
  assert.equal(load({ ownerQQ: 1 }).consolePort, 3100);
});

check('consolePort 合法数字/字符串数字 → 接受', () => {
  assert.equal(load({ ownerQQ: 1, consolePort: 3199 }).consolePort, 3199);
  assert.equal(load({ ownerQQ: 1, consolePort: '3199' }).consolePort, 3199);
});

check('consolePort 0 = 随机端口（测试/容器要靠它）', () => {
  assert.equal(load({ ownerQQ: 1, consolePort: 0 }).consolePort, 0);
});

check('consolePort 脏值 → 报错且说清字段与范围', () => {
  for (const bad of ['abc', 99999, -1, 3.5, {}, true]) {
    assert.throws(() => load({ ownerQQ: 1, consolePort: bad }),
      /consolePort 无效.*0（随机端口）或 1~65535/,
      `consolePort=${JSON.stringify(bad)} 必须被拒`);
  }
});

check('consolePort 空串/null → 视为未配置，回退 3100', () => {
  assert.equal(load({ ownerQQ: 1, consolePort: '' }).consolePort, 3100);
  assert.equal(load({ ownerQQ: 1, consolePort: null }).consolePort, 3100);
});

check('consoleHost 缺省 → 回环地址', () => {
  assert.equal(load({ ownerQQ: 1 }).consoleHost, '127.0.0.1');
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);