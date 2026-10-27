# 第三方技能（vendored）

本目录存放从上游仓库引入的 **agent 技能**。每个子目录必须带：

- `SKILL.md`（或等价入口）
- 上游 `LICENSE*` 原文
- 本文件登记：来源 URL、上游 commit、许可证、引入日期、**我们改了什么**

引入原则：只放**纯 markdown / 无网络、无脚本**的技能；任何会外发数据或需要额外运行时的
技能都不进仓库（要装就写在 `docs/guides/SKILLS.md` 里让使用者自己装）。

| 目录 | 上游 | commit | 许可证 | 引入日期 | 我们的改动 |
| --- | --- | --- | --- | --- | --- |
| `caveman/` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `9b68f7e`（2026-10-25） | Apache-2.0 | 2026-10-28 | **零改动**，原样复制 `skills/caveman/SKILL.md` 与许可证文件 |

## 关于 caveman

它是一份 **"说话风格"技能**：回答先行、砍掉客套、每个技术事实保留。

- 只影响**输出**（少说）。所谓"少读 / 压缩"要靠上游的 CLI 运行时（`@caveman-ai/cli`，
  需要 Node 22.13+），本仓库**没有**内置它 —— 原因见 `docs/guides/SKILLS.md` 的"我们为什么没装 CLI"。
- 它没有脚本、不联网、不外发数据，所以可以安全地 vendored 进仓库。

## 装到你的 agent 上

```powershell
# 自动探测技能目录并安装（--dry-run 先看会写哪里）
powershell -File scripts\install-skills.ps1 -Name caveman -DryRun
powershell -File scripts\install-skills.ps1 -Name caveman

# 卸载
powershell -File scripts\install-skills.ps1 -Name caveman -Uninstall
```

去重说明：本目录是**源**，安装脚本只是把它复制到 agent 的技能目录（`~/.claude/skills`、
`~/.dsh/skills` 或项目内 `.dsh/skills`），安装后两边内容一致，改一边要同步另一边。
