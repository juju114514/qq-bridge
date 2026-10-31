# 参与贡献（CONTRIBUTING）

> 本仓库是个人 fork（上游 `Derpyu520/qq-bridge`）。下面写的是**实际在用的流程**，不是理想流程。

## 1. 环境

- Node.js ≥ 22（仓库里有 `.nvmrc` 风格的说明见 `package.json` 的 `engines`）
- Windows 优先（大量脚本是 PowerShell）；Linux/macOS 能跑核心，但部署脚本没有等价物
- 包管理器：**npm**（`package-lock.json` 是唯一锁文件；用 pnpm 也能跑，但别把 `pnpm-lock.yaml` 提交进来）

```bash
npm install
cp config.example.json config.json   # 然后按注释填
```

## 2. 本地跑起来

```bash
node src/self-test.js        # 只测 DSH 链路（不需要 QQ）
node src/bridge.js           # 起桥接（需要 SnowLuma 已登录）
```

- 没有 SnowLuma 也能开发：`channel.enabled: false` 时桥接只做 sidecar（控制台 + 工具可用）
- DSH 端口每次可能不同：桥接会自动发现并写回 `config.json`

## 3. 测试（这是硬门槛）

```bash
node scripts/test-audit.mjs   # 全套审计，必须全绿
```

单独跑某一项：

```bash
node scripts/test-channel-epoch.mjs      # epoch fencing
node scripts/test-integration.mjs        # 跨模块集成
node scripts/check-md-links.mjs          # 文档链接
node scripts/check-privacy.mjs           # 隐私/凭证扫描
node scripts/test-dsh-contracts.mjs      # DSH 接口契约（需要 DSH 在跑）
```

**提交前必须全绿**。CI 也会跑 `test-audit.mjs` + 语法检查 + 可移植性检查。

## 4. 提交 PR

- 分支：**一律** `next/<版本号>`（例如 `next/0.4.49`）；**没有 hotfix 直推 main 的例外**
  （`AGENTS.md` 的「分支铁律」优先：main 只接受 `--no-ff` 合并的发布提交）
- 一个 PR **只做一类事**（修 bug / 加测试 / 文档）；不要混重构和功能
- Commit message 建议 `type(scope): 说明`（`fix` / `feat` / `docs` / `test` / `chore`）
- PR 描述里写：**改了什么、为什么、怎么验证的**（贴命令和输出）
- 有行为变化时，**必须**更新 `CHANGELOG.md`

## 5. 维护者的合并方式（据实说明）

- `--no-ff` 合并，保留分支历史
- 每个版本打 tag + 发 GitHub Release（正文从 `docs/releases/vX.Y.Z.md` 来）
- 版本号：小修补 `+0.0.1`，新能力 `+0.1.0`；不搞"SHA 当版本号"
- **不会**为了合并而重写你的提交历史

## 6. 许可

MIT。提交 PR 即表示你同意以 MIT 许可发布你的贡献。
第三方组件与数据出机清单见 `NOTICE.md`；角色卡的署名见 `roles/ATTRIBUTION.md`。

## 7. 安全

**不要在 Issue 里贴 token / secret / 真实群号 / 私聊记录。**
安全问题请按 `SECURITY.md` 私下报告。

---

## 附：几个"看起来能省事但会坏事"的做法

| 别做 | 为什么 |
| --- | --- |
| 直接 `git merge upstream/main` | 两边已经不可合并（领先 400+ 提交）；冲突会以**行为**形式出现 |
| 改 `dsh/agent-presets/` 里的产物 | 那是 `scripts/build-presets.mjs` 生成物；改真源 + 重新生成 |
| 在 `plugin/vendor/` 手改 | 有守卫校验副本与 `src/` 一致；改 `src/` 再重新 vendor |
| 提交 `config.json` / `state/` | 含凭证与会话数据；`.gitignore` 已挡，别 `-f` |