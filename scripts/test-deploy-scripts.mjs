// Linux 部署脚本的静态与逻辑回归（不需要 root，也不碰系统）。
//
// 为什么值得进 CI：deploy/*.sh 是**用户唯一会照着敲的东西**，此前的问题不是语法错，
// 而是「形做得很好、默认配置跑不通」——桥接被降权到 qqbridge，却仍需要读 DSH 的
// 本机签名密钥（$DSH_HOME/.credentials.yaml），安装脚本没给这份最小访问，
// 于是装完必然 DSH 401；npm 又用 `sudo -u` 丢了 HOME 导致缓存写 /root。
// 这类问题只有到服务器上才暴露，所以在这里用断言钉住：
//
//   1. `bash -n` 全部 deploy 脚本（真语法错）
//   2. unit 模板必须带 DSH_HOME 占位（否则服务进程永远找错 homedir）
//   3. install-server.sh 必须有：DSH 凭据探测 + 最小授权 + 以服务用户实测 + `sudo -H -u` npm
//   4. verify-server.sh 必须真的以服务用户身份验凭据可读（不是只看文件存在）
//   5. 纯逻辑自测（scripts/test-deploy-server-logic.sh）：主机判定 / 探测顺序 / 占位替换
//      —— Windows 上如果没有 bash，这一段跳过（不算失败）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployDir = path.join(root, 'deploy');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 找 bash ────────────────────────────────────────────────────────────────
// 关键：Windows 上 PATH 里的 `bash` 往往是 **WSL** 的 /bin/bash，它读不了 `D:/...`
// 这种路径（会报 No such file or directory，exit 127）。所以要**实测**：让候选
// bash 去 stat 一个真实仓库文件，能读到才采用。Git Bash 优先，WSL 兜底并转换路径。
const probeFile = path.join(root, 'package.json');

function bashCanRead(bin, candidatePath) {
  const r = spawnSync(bin, ['-c', `test -f "${candidatePath}" && echo ok`], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 && String(r.stdout).trim() === 'ok';
}

function wslPath(p) {
  // D:\a\b → /mnt/d/a/b
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function findBash() {
  const plain = process.platform === 'win32'
    ? [probeFile.replace(/\\/g, '/'), probeFile]
    : [probeFile];
  const candidates = process.platform === 'win32'
    // 显式 Git Bash 优先：能直接吃 Windows 路径
    ? ['C:/Program Files/Git/bin/bash.exe', 'D:/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', 'bash', '/bin/bash']
    : ['bash', '/bin/bash', '/usr/bin/bash'];
  for (const bin of candidates) {
    for (const candidatePath of plain) {
      if (bashCanRead(bin, candidatePath)) return bin;
    }
    // WSL/Cygwin 兜底：换成它们认的路径再试
    if (process.platform === 'win32' && bashCanRead(bin, wslPath(probeFile))) return { bin, converter: wslPath };
  }
  return null;
}

const bashFound = findBash();
const bash = bashFound && typeof bashFound === 'object' ? bashFound.bin : bashFound;
const bashConverter = (bashFound && typeof bashFound === 'object' && bashFound.converter) || null;

// 把路径交给 bash：Git Bash 用正斜杠即可（反斜杠会被当转义吃掉）；
// WSL 需要 /mnt/d/... 形式。
const forBash = (p) => {
  if (bashConverter) return bashConverter(p);
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
};

// ── 1. bash -n：真语法错 ───────────────────────────────────────────────────
const scripts = fs.readdirSync(deployDir).filter((f) => f.endsWith('.sh')).sort();
check(`deploy/ 下有 ${'>= 5'} 个脚本`, () => {
  assert.ok(scripts.length >= 5, `实际 ${scripts.length}: ${scripts.join(', ')}`);
});

if (!bash) {
  console.log('  skip bash -n（没有 bash，非 Linux/macOS 环境）');
} else {
  for (const script of scripts) {
    check(`bash -n deploy/${script}`, () => {
      const r = spawnSync(bash, ['-n', forBash(path.join(deployDir, script))], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 0, (r.stderr || r.stdout || '').trim());
    });
  }
}

// ── 2. unit 模板：DSH_HOME 占位 + 仍是低权限 ───────────────────────────────
const unit = read('deploy/qq-bridge.service');
check('unit 模板带 DSH_HOME 占位（install 会替换成真实路径）', () => {
  assert.match(unit, /Environment=DSH_HOME=__DSH_HOME__/, '缺 Environment=DSH_HOME=__DSH_HOME__');
});
check('unit 仍保留降权与硬化（User / NoNewPrivileges / ProtectSystem）', () => {
  assert.match(unit, /^User=__USER__$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=Full$/m);
  // ProtectHome=read-only 是**必须**的：既要能读 $DSH_HOME/.credentials.yaml，
  // 又不该给它写家目录的能力。改成 yes 会让凭据读不到。
  assert.match(unit, /^ProtectHome=read-only$/m);
});

// ── 3. install-server.sh：四件必须做的事都在 ───────────────────────────────
const install = read('deploy/install-server.sh');
check('install 探测 DSH_HOME（含 --dsh-home / $DSH_HOME / 多候选）', () => {
  assert.match(install, /--dsh-home\)/, '缺 --dsh-home 参数');
  assert.match(install, /detect_dsh_home\(\)/, '缺 detect_dsh_home()');
  assert.match(install, /\.credentials\.yaml/, '没有检查 .credentials.yaml');
  assert.match(install, /\/root\/\.dsh/, '候选里没有 /root/.dsh（root 登录 DSH 的常见位置）');
});
check('install 只授予最小权限（ACL x/r，不整目录 777）', () => {
  assert.match(install, /setfacl -m "u:\$USER_NAME:--x"/, '缺目录穿越 ACL(--x)');
  assert.match(install, /setfacl -m "u:\$USER_NAME:r--"/, '缺文件读 ACL(r--)');
  assert.doesNotMatch(install, /chmod 777/, '出现了 chmod 777');
  assert.doesNotMatch(install, /chmod -R 755 \/root/, '放开了 /root');
});
check('install 以服务用户身份实测可读（不是只看 mode 位）', () => {
  assert.match(install, /sudo -u "\$USER_NAME" test -r "\$CRED_FILE"/, '缺实测');
});
check('install 把 DSH_HOME 写进 unit', () => {
  assert.match(install, /__DSH_HOME__#\$\{DSH_HOME_FOUND\}/, 'unit 替换没带 DSH_HOME_FOUND');
});
check('install 的 npm 用 sudo -H -u（否则缓存写 /root → EACCES）', () => {
  assert.match(install, /sudo -H -u "\$USER_NAME".*npm/, '缺 sudo -H -u npm');
  assert.doesNotMatch(install, /sudo -u "\$USER_NAME" "\$\(command -v npm\)"/, '还残留不带 -H 的 npm 调用');
});
check('install 区分「DSH 在另一台机器」的情形（铸造不成立，应引导 authToken）', () => {
  assert.match(install, /DSH_LOCAL/, '缺本机/远程判定');
  assert.match(install, /authToken/, '没引导改用 authToken');
});

// ── 4. verify-server.sh：凭据检查要以服务用户身份 ──────────────────────────
const verify = read('deploy/verify-server.sh');
check('verify 以服务用户身份验凭据可读', () => {
  assert.match(verify, /as_user_readable/, '缺 as_user_readable()');
  assert.match(verify, /runuser -u "\$SVC_USER"/, '缺 runuser 分支');
  assert.match(verify, /DSH 凭据/, '缺「DSH 凭据」这一行结果');
});
check('verify 会从 systemd 读服务用户与 DSH_HOME（而不是猜 qqbridge）', () => {
  assert.match(verify, /systemctl show -p User --value qq-bridge/, '没读 unit 的 User');
  assert.match(verify, /systemctl show -p Environment --value qq-bridge/, '没读 unit 的 DSH_HOME');
});

// ── 5. 纯逻辑自测（bash 存在时）────────────────────────────────────────────
const logicTest = path.join(root, 'scripts', 'test-deploy-server-logic.sh');
if (!bash) {
  console.log('  skip test-deploy-server-logic.sh（没有 bash）');
} else if (!fs.existsSync(logicTest)) {
  check('test-deploy-server-logic.sh 存在', () => { throw new Error('缺 scripts/test-deploy-server-logic.sh'); });
} else {
  check('纯逻辑自测：主机判定 / 探测顺序 / 占位替换 / --help 区间', () => {
    const r = spawnSync(bash, [forBash(logicTest)], { encoding: 'utf8', timeout: 60000, cwd: forBash(root) });
    assert.equal(r.status, 0, `${(r.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join(' | ') || r.stderr}`);
  });
}

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
