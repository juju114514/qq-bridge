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
import { spawnSync } from 'node:child_process';

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

// ── 6. 文档里的相对链接必须指向真文件（悬空引用比没写更糟）────────────────
check('NOTICE.md 里提到的决策记录真实存在', () => {
  const notice = read('NOTICE.md');
  if (!notice.includes('docs/design/decisions/')) {
    // 允许以后改措辞：只要不再提这个目录，就不校验
    return;
  }
  const dir = path.join(root, 'docs/design/decisions');
  assert.ok(fs.existsSync(dir), 'NOTICE.md 提到 docs/design/decisions/ 但目录不存在');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 1, 'docs/design/decisions/ 里没有决策记录');
  // 提到就要真的链到具体文件，而不是只给一个目录（那样读者点不进去）
  assert.match(notice, /docs\/design\/decisions\/[0-9]{4}-[a-z0-9-]+\.md/, 'NOTICE.md 只给了目录、没链到具体记录');
  const rel = notice.match(/docs\/design\/decisions\/([0-9]{4}-[a-z0-9-]+\.md)/)[1];
  assert.ok(fs.existsSync(path.join(dir, rel)), `NOTICE.md 链到的 ${rel} 不存在`);
});

// ── 7. 第三方 IP 的归属声明（角色卡 / 素材）────────────────────────────────
// 这两类内容不属于本项目版权，但又是"展示效果"的一部分，很容易被顺手提交进来而
// 没有任何归属说明。少一行归属 = 让使用者替项目背 IP 风险，所以必须钉住。
check('roles/ATTRIBUTION.md 存在，且列出现有每张角色卡', () => {
  const attrPath = path.join(root, 'roles', 'ATTRIBUTION.md');
  assert.ok(fs.existsSync(attrPath), '缺 roles/ATTRIBUTION.md');
  const attr = fs.readFileSync(attrPath, 'utf8');
  const cards = fs.readdirSync(path.join(root, 'roles'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'ATTRIBUTION.md');
  assert.ok(cards.length >= 1, 'roles/ 下没有角色卡？');
  for (const card of cards) {
    assert.ok(attr.includes(card), `ATTRIBUTION.md 没有列出 ${card}`);
  }
  for (const owner of ['miHoYo', 'DeepSeek', 'Acacia']) {
    assert.ok(attr.includes(owner), `ATTRIBUTION.md 缺权利方 ${owner}`);
  }
});

check('每张含第三方角色的卡都带归属行（指向 ATTRIBUTION.md）', () => {
  const dir = path.join(root, 'roles');
  const cards = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'ATTRIBUTION.md');
  for (const card of cards) {
    const text = fs.readFileSync(path.join(dir, card), 'utf8');
    // 傲娇助手是本项目原创，不要求第三方归属，但也要能在 ATTRIBUTION 里查到
    if (card.startsWith('傲娇助手')) continue;
    assert.match(text, /roles\/ATTRIBUTION\.md/, `${card} 缺归属行（应指向 roles/ATTRIBUTION.md）`);
    assert.match(text, /版权|商标/, `${card} 的归属行没说清权利方`);
  }
});

check('角色卡不得以 UTF-8 BOM 开头（会让 H1 识别失败）', () => {
  const dir = path.join(root, 'roles');
  for (const card of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const buf = fs.readFileSync(path.join(dir, card));
    assert.notDeepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], `${card} 带 UTF-8 BOM`);
  }
});

check('assets/README.md 说明了 deepseek娘.png 的归属', () => {
  const p = path.join(root, 'assets', 'README.md');
  assert.ok(fs.existsSync(p), '缺 assets/README.md');
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /deepseek娘\.png/, 'assets/README.md 没提 deepseek娘.png');
  assert.match(text, /DeepSeek/, 'assets/README.md 没写权利方');
  assert.match(text, /不覆盖|不声称任何授权/, 'assets/README.md 没说清 MIT 不覆盖它');
});

// ── 回归：postinstall 这类 `node -e "…"` 脚本必须是**合法 JS** ─────────────
// 踩过的坑（2026-10-27）：scripts.postinstall 里的中文被写成 mojibake，还**少了一个右引号**，
// `node -e` 直接 SyntaxError → `npm install` 在 postinstall 阶段失败 → 全新机器根本装不上。
// 这种错 `node --check package.json` 查不出来（JSON 本身合法），只能真跑一次。
check('package.json 里每个 node -e 脚本都能真正执行（引号配对 + 无乱码）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const inline = Object.entries(pkg.scripts ?? {}).filter(([, cmd]) => /^node -e "/.test(String(cmd)));
      // 0.4.4 起不再强制要求 postinstall：仓库根的 postinstall 会让 git 方式安装插件被 pnpm 拦下（ERR_PNPM_IGNORED_BUILDS）
  for (const [name, cmd] of inline) {
    const inner = String(cmd).replace(/^node -e "/, '').replace(/"$/, '');
    assert.equal((inner.match(/'/g) ?? []).length % 2, 0, `${name}: 单引号不配对（内层脚本非法）`);
    assert.doesNotMatch(inner, /[\ue000-\uf8ff]/, `${name}: 含私用区字符（UTF-8 被当 GBK 读过的痕迹）`);
    const run = spawnSync(process.execPath, ['-e', inner], { encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `${name}: 执行失败\n${run.stderr}`);
  }
});

check('内联脚本的输出能正常打印（有就校验；0.4.4 起不强制有 postinstall）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cmd = String(pkg.scripts?.postinstall ?? '');
  if (!cmd) { /* 没有 postinstall 是合法的：见上面 0.4.4 的说明 */ return; }
  const inner = cmd.replace(/^node -e "/, '').replace(/"$/, '');
  const run = spawnSync(process.execPath, ['-e', inner], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /\[qq-bridge\]/, '应打印带 [qq-bridge] 前缀的一行提示');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}