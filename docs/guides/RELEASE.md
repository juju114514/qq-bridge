# 发版流程（Windows，用 GitHub CLI）

> 目标：一条命令把 tag + Release 都发出去，正文与代码一致。
> `gh` 已经装好（winget 装的 `GitHub.cli`，2.103.3），配置在
> `%APPDATA%\GitHub CLI\hosts.yml`。

## 一、准备

```powershell
# 看 gh 状态（会提示缺 read:org —— 不影响 repo/release 操作，见文末）
gh auth status

# 确认默认仓库钉在本 fork（否则它可能猜成 upstream Derpyu520/qq-bridge）
gh repo set-default juju114514/qq-bridge
```

## 二、发一版（五步）

```powershell
# 1) 版本号对齐：package.json / compat.json 的 bridge 字段
# 2) 写 CHANGELOG 条目（用户能感知的变化 + 踩过的坑）
# 3) 写正文：docs/releases/vX.Y.Z.md（GitHub Release 用绝对链接）
# 4) 提交 + 打标签 + 推
git add -A
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — 一句话亮点"
git push origin main
git push origin vX.Y.Z

# 5) 发 Release（--verify-tag 保证标签真的在远端）
gh release create vX.Y.Z `
  --repo juju114514/qq-bridge `
  --title "vX.Y.Z · 一句话亮点" `
  --notes-file docs\releases\vX.Y.Z.md `
  --verify-tag
```

## 三、校验

```powershell
gh release list
gh release view vX.Y.Z --json tagName,isDraft,publishedAt,url
node scripts/test-audit.mjs        # 应当全绿
```

## 四、两个坑（都踩过）

1. **`gh` 会把仓库猜成 upstream**
   本地同时有 `origin`（fork）和 `upstream`（原仓库）时，`gh` 可能选后者，
   报 `tag ... doesn't exist in the repo Derpyu520/qq-bridge`。
   解决：显式 `--repo juju114514/qq-bridge`，并 `gh repo set-default` 钉住。

2. **token 缺 `read:org`**
   `gh auth login --with-token` 会拒绝（要求 read:org），但走 `GH_TOKEN` 环境变量能直接用。
   目前 `hosts.yml` 里是 Git Credential Manager 的 OAuth token，scopes 是
   `gist, repo, workflow` —— **repo / release / issue / api 都能用**，只有少数需要 org 信息的命令会警告。
   想要完整权限：`gh auth refresh -h github.com`（浏览器授权一次）。

## 五、版本号与标签的关系（重要）

**Release 正文必须与标签指向的代码一致。**

例子：`v0.3.1` 打在 `e6375fc`，之后又合了 5 个提交（含"角色卡按节奏注入"）。
如果直接在 `v0.3.1` 上发 Release、正文却写了新功能，就是自相矛盾 ——
正确做法是**新开一个版本点**（`v0.3.2`），让标签、正文、代码三者对齐。