// 环境快照（DSH 升级前后各跑一次，用来做「适配差异」对比）
//
// 为什么要有它：DSH 是 nightly 通道、插件 API 还在动。升级后"哪儿坏了"如果只靠回忆，
// 就会变成"感觉没以前好用"。把升级前的可观测状态存成文件，升级后 diff 一下，差异就是适配清单。
//
// 用法：
//   node scripts/snapshot-env.mjs            # 生成 docs/validation/env-snapshot-<日期>.md
//   node scripts/snapshot-env.mjs --compare  # 与目录里最新的一份对比（打印差异）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'validation');

const safe = (fn, fallback = '') => { try { return fn(); } catch { return fallback; } };

function readJson(p, fallback = {}) {
  return safe(() => JSON.parse(fs.readFileSync(p, 'utf8')), fallback);
}

function exeVersionVersionInfo(exe) {
  // 不调 PowerShell：从 exe 里扫 UTF-16 的 FileVersion 字段不可靠，
  // 这里退而求其次用「文件大小 + mtime」，版本号由调用方另外从 PowerShell 取（可选）。
  const st = safe(() => fs.statSync(exe), null);
  if (!st) return null;
  return { sizeMB: Math.round(st.size / 1024 / 1024), mtime: st.mtime.toISOString() };
}

// 不硬编码盘符（portability 测试会红）：默认从环境变量取，取不到就按
// 「本文件所在的仓库 → 往上两级」推断一个候选，最后才回落到 Windows 默认安装位置。
const DSH_DIR = process.env.DSH_INSTALL_DIR
  || process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'deep-seek')
  || '';
const DSH_EXE = DSH_DIR ? path.join(DSH_DIR, 'DeepSeek Harness.exe') : '';

const repoPkg = readJson(path.join(root, 'package.json'));
const pluginPkg = readJson(path.join(root, 'plugin', 'package.json'));
const pluginManifest = readJson(path.join(root, 'plugin', 'dsh.plugin.json'));
const cfgPath = path.join(root, 'config.json');
const cfg = readJson(cfgPath, null);

const installedPlugin = path.join(process.env.USERPROFILE || '', '.dsh', 'plugins', 'qq-bridge-plugin');
const installedManifest = readJson(path.join(installedPlugin, 'dsh.plugin.json'), {});

const git = (args) => safe(() => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(), '');

// 用**本地**日期：toISOString() 是 UTC，东八区凌晨会写成前一天
const now = new Date();
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const snapshot = {
  generatedAt: `${localDate} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  localDate,
  dsh: {
    installDir: DSH_DIR,
    exe: DSH_EXE,
    exeInfo: DSH_EXE ? exeVersionVersionInfo(DSH_EXE) : null,
    versionFromPs: process.env.DSH_VERSION || '(运行 snapshot 时用 PowerShell 读 FileVersion 填入)',
    updateChannel: DSH_DIR
      ? safe(() => {
        const yml = fs.readFileSync(path.join(DSH_DIR, 'resources', 'app-update.yml'), 'utf8');
        return yml.match(/channel:\s*(\S+)/)?.[1] || '';
      }, '')
      : ''
  },
  runtime: { node: process.version, platform: `${process.platform} ${process.arch}` },
  repo: { version: repoPkg.version, head: git(['rev-parse', '--short', 'HEAD']), tag: git(['describe', '--tags', '--abbrev=0']) },
  plugin: {
    version: pluginPkg.version,
    name: pluginPkg.name,
    id: pluginManifest.id,
    engines: pluginManifest.engines,
    tools: (pluginManifest.contributes?.tools || []).length,
    installedVersion: installedManifest.version || '(未安装)'
  },
  config: cfg
    ? {
        keys: Object.keys(cfg).sort(),
        official: {
          enabled: cfg.official?.enabled === true,
          hasAppid: Boolean(cfg.official?.appid),
          hasSecret: Boolean(cfg.official?.secret),
          ownerOpenidConfigured: Boolean(cfg.official?.ownerOpenid),
          allowCount: Array.isArray(cfg.official?.allow) ? cfg.official.allow.length : 0
        },
        allowPrivateCount: Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0,
        allowGroupsCount: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0
      }
    : { keys: [], note: '没有 config.json（可能是干净克隆）' }
};

const md = `# 环境快照 · ${snapshot.generatedAt.slice(0, 10)}

> 由 \`node scripts/snapshot-env.mjs\` 生成。升级 DSH 前后各跑一次，diff 出适配清单。

| 项 | 值 |
| --- | --- |
| DSH 安装目录 | \`${snapshot.dsh.installDir}\` |
| DSH 更新通道 | ${snapshot.dsh.updateChannel || '(未知)'} |
| DSH exe 大小 / 时间 | ${snapshot.dsh.exeInfo ? `${snapshot.dsh.exeInfo.sizeMB} MB / ${snapshot.dsh.exeInfo.mtime.slice(0, 19)}` : '(找不到 exe)'} |
| DSH 版本（PowerShell FileVersion） | ${snapshot.dsh.versionFromPs} |
| Node | ${snapshot.runtime.node} |
| 仓库版本 | ${snapshot.repo.version} (${snapshot.repo.head}${snapshot.repo.tag ? ` · ${snapshot.repo.tag}` : ''}) |
| 插件版本（仓库） | ${snapshot.plugin.version} · id=${snapshot.plugin.id} · 工具 ${snapshot.plugin.tools} 个 |
| 插件版本（已安装） | ${snapshot.plugin.installedVersion} |
| 插件要求 DSH | \`${snapshot.plugin.engines?.dsh || '(未声明)'}\` |
| 配置键数 | ${snapshot.config.keys?.length ?? 0} |
| 官方通道 | enabled=${snapshot.config.official?.enabled} appid=${snapshot.config.official?.hasAppid} secret=${snapshot.config.official?.hasSecret} owner=${snapshot.config.official?.ownerOpenidConfigured} allow=${snapshot.config.official?.allowCount} |
| 白名单 | private ${snapshot.config.allowPrivateCount} 项 / groups ${snapshot.config.allowGroupsCount} 项 |

## 完整数据（JSON）

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\`
`;

if (process.argv.includes('--compare')) {
  const files = safe(() => fs.readdirSync(outDir).filter((f) => f.startsWith('env-snapshot-')).sort(), []);
  const prev = files.filter((f) => !f.startsWith(`env-snapshot-${snapshot.localDate}`)).pop();
  if (!prev) {
    console.log('  没有可对比的历史快照（这是第一份）');
  } else {
    const prevJson = safe(() => {
      const text = fs.readFileSync(path.join(outDir, prev), 'utf8');
      return JSON.parse(text.split('```json')[1].split('```')[0]);
    }, null);
    console.log(`  对比基准：${prev}`);
    const flatten = (o, prefix = '') => Object.entries(o || {}).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}=${Array.isArray(v) ? v.length + ' 项' : v}`]);
    const a = new Map(flatten(prevJson).map((line) => line.split('=').slice(0, 1).concat(line.split('=').slice(1).join('=')).slice(0, 2)));
    const b = new Map(flatten(snapshot).map((line) => line.split('=').slice(0, 1).concat(line.split('=').slice(1).join('=')).slice(0, 2)));
    let diffs = 0;
    for (const [k, v] of b) {
      if (!a.has(k)) { console.log(`   + ${k} = ${v}`); diffs += 1; }
      else if (String(a.get(k)) !== String(v)) { console.log(`   ~ ${k}: ${a.get(k)} → ${v}`); diffs += 1; }
    }
    for (const k of a.keys()) if (!b.has(k)) { console.log(`   - ${k}（消失了）`); diffs += 1; }
    console.log(diffs ? `  差异 ${diffs} 处 —— 逐条判断是否影响插件/控制台/通道` : '  没有差异');
  }
} else {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `env-snapshot-${snapshot.localDate}.md`);
  fs.writeFileSync(file, md);
  console.log(`  ✓ 已写入 ${path.relative(root, file)}`);
  console.log(`    仓库 ${snapshot.repo.version} · 插件 ${snapshot.plugin.version} · 配置键 ${snapshot.config.keys?.length ?? 0} 个`);
}
