# 干净克隆验收 · 2026-10-31

目的：证明**别人把仓库 clone 下来、装完依赖就能跑通全套审计**，
而不是只有我这台已经跑了几天的机器能过。

## 结论

| 步骤 | 结果 |
| --- | --- |
| `git clone` 后直接跑审计 | **78/98**（缺依赖，见下） |
| 装完依赖后跑审计 | **98/98 通过** |

**代码本身没有"只有在作者机器上才过"的测试。** 唯一的坑是安装方式（见第三节）。

## 一、复现步骤

```powershell
git clone https://github.com/juju114514/qq-bridge.git clean-clone
cd clean-clone
npm ci            # 仓库口径是 npm，有 package-lock.json
node scripts/test-audit.mjs
```

期望输出最后一行：

```
Audit suite: 98/98 scripts passed.
```

## 二、第一次跑会看到 20 个失败——都是缺依赖

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml'
  imported from .../src/preset-prompt.js
```

`node_modules/` 在 `.gitignore` 里，克隆下来本来就没有。
**20 个失败里没有一个是真 bug**，装完依赖全部消失。

## 三、坑：用 pnpm 装会让 `test-packaging` 变红

我这次偷懒用了 `pnpm install`（这台机器的 PATH 里没有 npm），结果多出 `pnpm-lock.yaml`：

```
FAIL 只有一个依赖锁文件（package-lock.json）
     实际: package-lock.json, pnpm-lock.yaml
```

这条断言是对的 —— 两套锁文件会让不同人装出不同的依赖树。
我保留断言，改的是**预防**：`.gitignore` 里加了 `pnpm-lock.yaml`，
免得有人用 pnpm 装完顺手把它提交上来。

## 四、顺带确认：`test-first-run` 在干净克隆里是通过的

之前记录过"它读仓库根 `config.json`（被 gitignore）会失败"，实测 **10 组全过**：

```
ok   first-run.ps1 存在且是 UTF-8 带 BOM
ok   DryRun 在真实仓库上成功且不改动 config.json
ok   空仓库里 DryRun 以非 0 退出，且不会偷偷创建 config.json
...
```

也就是说这条历史欠账**已经不成立了**，可以从待办里划掉。

## 五、还没覆盖的

| 项 | 说明 |
| --- | --- |
| Windows 以外的平台 | 只有 `docs/validation/linux-run-2026-10-30.md` 的一次手工记录，没有 CI |
| 真机联调 | 审计不碰 QQ / DSH，网关相关只能人工验（见各提交的「真机验证」段） |
| `test-reply-wait` | 已知时序敏感，全量跑偶发红（单独跑 10/10 过） |