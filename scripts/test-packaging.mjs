// 打包形态回归：锁文件唯一 + 许可证可被 GitHub 识别。
//
// 由来（外部 review 提的两条，实测都成立）：
//   1. 仓库里同时有 package-lock.json 与 pnpm-lock.yaml ⇒ 两个人用不同包管理器
//      会各自改各自的锁文件，依赖树迟早漂移。README/CI/postinstall 全用 npm，
//      所以 pnpm-lock.yaml 是纯粹的死重量。
//   2. LICENSE 里除了 MIT 正文还挂了一大段中文附录 ⇒ GitHub 的 licensee 匹配失败，
//      仓库页面显示 `Other / NOASSERTION`，别人看不到「MIT」，想用的人反而不敢用。
//      修法是「LICENSE 只放协议正文，附录搬到 NOTICE.md」，而不是改协议。
//
// 这两类问题不会让任何代码测试变红，却直接影响别人敢不敢用 —— 所以单独钉住。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

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

// ── 1. 锁文件只能有一个，且必须是 README 里说的那个 ────────────────────────
check('只有一个依赖锁文件（package-lock.json）', () => {
  const locks = fs.readdirSync(root).filter((f) => /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f));
  assert.deepEqual(locks, ['package-lock.json'],
    `实际: ${locks.join(', ') || '（无）'} —— 多套锁文件会让依赖树按包管理器漂移`);
});

check('README / CI / 安装脚本三处的包管理器口径一致（都是 npm）', () => {
  const readme = read('README.md');
  const ci = read('.github/workflows/ci.yml');
  const installer = read('deploy/install-server.sh');
  assert.match(readme, /npm install/, 'README 不再用 npm install？');
  assert.match(installer, /npm install/, 'install-server.sh 不再用 npm install？');
  // CI 用 npm ci 或 npm install 都行，但不能出现 pnpm/yarn 的安装步骤
  assert.doesNotMatch(ci, /\bpnpm (install|i)\b/, 'CI 里出现 pnpm 安装步骤');
  assert.doesNotMatch(readme, /\bpnpm (install|i)\b/, 'README 里出现 pnpm 安装步骤');
});

check('.gitattributes 不再提 pnpm-lock', () => {
  const ga = read('.gitattributes');
  assert.doesNotMatch(ga, /pnpm-lock\.yaml/, '.gitattributes 还留着 pnpm-lock 行');
});

// ── 2. LICENSE 必须是「GitHub 认得出」的纯 MIT ────────────────────────────
const license = read('LICENSE');
const licenseLines = license.trimEnd().split('\n');

check('LICENSE 是纯 MIT 正文（21 行，结尾 SOFTWARE.）', () => {
  assert.equal(licenseLines[0].trim(), 'MIT License', `首行是「${licenseLines[0]}」`);
  assert.match(licenseLines[licenseLines.length - 1].trim(), /^SOFTWARE\.$/, '末行不是 SOFTWARE.');
  // 标准 MIT 正文 21 行；多出来基本就是把附录又塞回去了
  assert.ok(licenseLines.length <= 25,
    `LICENSE 有 ${licenseLines.length} 行（标准 MIT 21 行）—— 附录请放 NOTICE.md，否则 GitHub 会判成 NOASSERTION`);
});

check('LICENSE 里没有 Markdown 标题/表格（那是 licensee 匹配失败的主因）', () => {
  assert.doesNotMatch(license, /^#{1,6}\s/m, 'LICENSE 里出现 Markdown 标题');
  assert.doesNotMatch(license, /^\|/m, 'LICENSE 里出现表格');
});

check('LICENSE 保留项目自己的版权行', () => {
  assert.match(license, /Copyright \(c\) 2026 Derpyu520 and qq-bridge \/ QSH contributors/);
});

// ── 3. 附录（NOTICE.md）不能丢内容 ─────────────────────────────────────────
check('NOTICE.md 存在，且带走了原有的关键章节', () => {
  assert.ok(exists('NOTICE.md'), '缺 NOTICE.md');
  const notice = read('NOTICE.md');
  for (const needle of [
    '第三方组件与合规边界',
    '数据出机清单',
    '关于 SnowLuma 许可的说明',
    '已知的依赖许可瑕疵',
    '使用风险提示',
  ]) {
    assert.ok(notice.includes(needle), `NOTICE.md 缺「${needle}」`);
  }
});

check('NOTICE.md 说明了自己不是协议（避免被误解为许可条款）', () => {
  const notice = read('NOTICE.md');
  assert.match(notice, /不是许可证的一部分|不改变、也不扩张 MIT/, 'NOTICE.md 没写清它与 MIT 的关系');
});

// ── 4. package.json 的 license 与 LICENSE 一致 ────────────────────────────
check('package.json 的 license 字段是 MIT（与 LICENSE 一致）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'MIT', `实际 ${JSON.stringify(pkg.license)}`);
});

// ── 5. 文档不再把「合规说明」指向 LICENSE ──────────────────────────────────
check('README 指向 NOTICE.md 而不是 LICENSE 去读合规说明', () => {
  const readme = read('README.md');
  assert.match(readme, /\[NOTICE\.md\]\(NOTICE\.md\)/, 'README 没有指向 NOTICE.md');
  assert.doesNotMatch(readme, /\[LICENSE\]\(LICENSE\) 的「数据出机清单」/, 'README 还把「数据出机清单」指向 LICENSE');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
