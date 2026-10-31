# 分支与发版策略（2026-10-31 起生效）

> 起因：仓库是公开的，别人可能随时 clone / 跟 main。
> **不能"改一条就推一条 main"** —— 别人正好在你改到一半时拉代码，就会拿到半成品。

## 一、铁律

1. **main 永远是"可发布态"**：任何时刻 clone main 都应该能跑通审计。
2. **所有开发提交进 `next/X.Y.Z` 分支**，不直接动 main。
3. **攒够一批再合并**：合并 = 一次大版本 + 一个 GitHub Release。
4. 只有这三种情况可以直接动 main：
   - 修**线上事故**（先修再补记 changelog，commit message 标 `hotfix:`）
   - 改**纯文档里的错别字/死链**
   - 发版本身（版本号、CHANGELOG、Release notes）

## 二、分支命名

```
next/0.4.0        ← 下一个"大版本"的集成分支（现在就在用）
next/0.3.3        ← 如果只想攒一两个小修
hotfix/xxx        ← 线上事故，从 main 切，修完直接合回 main 并发 0.0.x
```

## 三、版本号规则

| 改了什么 | 版本 | 例子 |
| --- | --- | --- |
| **大更新**（新架构 / 新能力 / 行为变化） | **+0.1.0** | `0.3.2 → 0.4.0` |
| **小更新**（修 bug / 加配置项 / 文档批量） | **+0.0.1** | `0.3.2 → 0.3.3` |
| 只在分支上迭代期间 | **不动版本号** | 分支名就是预定的版本 |

> 每次合并到 main 时**只 bump 一次**，不要在分支上反复改 `package.json`。

## 四、一次完整发布的流程

```powershell
# 1) 在 next/X.Y.Z 上攒提交（可以很多个，随便推分支，不影响 main 的读者）
git push origin next/X.Y.Z

# 2) 收工时：先自检
node scripts/test-audit.mjs          # 必须全绿
node scripts/check-md-links.mjs
node scripts/check-privacy.mjs
node scripts/snapshot-prompt.mjs --diff <最近基线>   # 期望「行为一致 ✓」或已解释的差异

# 3) 合回 main（--no-ff 保留"这是一批"的痕迹）
git checkout main
git merge --no-ff next/X.Y.Z -m "release: vX.Y.Z — 一句话"
git tag -a vX.Y.Z -m "vX.Y.Z — 一句话"
git push origin main
git push origin vX.Y.Z

# 4) 发 Release（见 docs/guides/RELEASE.md）
gh release create vX.Y.Z --title "vX.Y.Z · 一句话" --notes-file docs\releases\vX.Y.Z.md --verify-tag

# 5) 开下一轮分支
git checkout -b next/X.Y.(Z+1)
```

## 五、为什么这么做

- **读者安全**：main 上永远是"发过的版本"，不会拿到改一半的代码
- **审计友好**：一个 `--no-ff` 合并点 = 一次完整变更集，`git log --first-parent` 就是发版历史
- **回滚便宜**：出问题回退到上一个 tag，而不是在 main 上 revert 一堆碎提交
- **Release 有意义**：版本号与内容严格对应（v0.3.1 的教训：标签在 e6375fc，正文却写了后来的功能）

## 六、分支生命周期

- `next/X.Y.Z` 合并后**保留**（作为历史），不再提交
- 线上事故 `hotfix/*` 修完合并即删