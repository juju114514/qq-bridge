# 自更新（安全版）

> 学的是别人家的更新流程，但补了它缺的三件事：**备份、健康检查、自动回滚**。
> 脚本：`scripts/update.mjs`；启动器菜单第 8 项也能检查。

---

## 一、为什么不用 `git pull`

| 方式 | 问题 |
| --- | --- |
| `git pull` | 本地改了 `config.json` / `state/` 会冲突；merge 冲突还要手工解 |
| 覆盖 zip | 容易把 `config.json`、`state/` 一起盖掉 |

我们的做法：**只覆盖程序文件，运行态与凭证一律不动**。

---

## 二、三步，每步都能单独跑

```powershell
node scripts\update.mjs --check        # 1) 只对比版本，不改任何东西
node scripts\update.mjs --download     # 2) 下到 _update\（不碰线上）
node scripts\update.mjs --apply --yes  # 3) 备份 → 覆盖 → 重启 → 健康检查（失败自动回滚）
```

国内网络访问 GitHub 常超时，加代理：

```powershell
node scripts\update.mjs --check --proxy http://127.0.0.1:7897
```

不确定会发生什么时，先预演：

```powershell
node scripts\update.mjs --apply --dry-run
```

预演只解压 + 统计「将覆盖哪些顶层条目」，**不写任何文件、不重启**。

---

## 三、受保护清单（绝不覆盖）

```
config.json   state/        node_modules/   .git/
data/         logs/         audio/          cookies.txt
_update/      _rollback/
```

---

## 四、失败了会怎样

1. 覆盖前先整份备份到 `_rollback\<旧版本>-<时间戳>\`
2. 覆盖后**等 `/health/detail` 报出新版本**（最多 60 秒）
3. 没等到 → 自动回滚：删掉本次新增的文件，把备份拷回去，再重启一次
4. 回滚后仍起不来 → 明确告诉你「需要人工处理」，并指向 `state/bridge.log` 与备份目录

> 这一条是重点：**别人的更新器出过「关掉进程后没人拉起」的事故**。
> 我们的更新器**不负责重启**——重启交给计划任务/runner（那份守护是验证过的）。

---

## 五、和「别人的更新器」对照

| | 常见做法 | 我们 |
| --- | --- | --- |
| 下载 | 应用内下载 | ✅ 一样，下到 `_update/` |
| 生效时机 | 提示「重启后生效」 | ✅ 一样，明确让你选 |
| 保留数据 | 承诺保留 | ✅ 硬编码保护清单，代码层面不会碰 |
| 重启 | 更新器自己重启自己 | ❌ 交外部守护（runner / 计划任务） |
| 失败回滚 | 多数没有 | ✅ 有，且会清理新增文件 |
| 校验 | 少数有 | ✅ 健康检查版本号必须对上 |

---

## 六、排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `查不到最新版本` | 网络/代理 | 加 `--proxy`，或先开代理 |
| `更新包里没有 package.json` | 解压结构不对 | 别手工改 tarball；用 `--download` 下的原包 |
| 健康检查一直不过 | 服务没起来 | 看 `state/bridge.log`；脚本已自动回滚 |
| `--apply` 提示要 `--yes` | 防误触 | 确认后加 `--yes`（或设 `QQB_UPDATE_YES=1`） |
