#!/usr/bin/env node
// 生成 bridge.js 的符号索引（docs/bridge-map.md）
// 目的：改代码前先看索引定位行号，再去精读 ±30 行，避免整文件加载。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "bridge.js");
const OUT = path.join(ROOT, "docs", "bridge-map.md");
const lines = fs.readFileSync(SRC, "utf8").split("\n");

const routes = [];
const funcs = [];
const imports = [];
const consts = [];

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  let m;
  if ((m = l.match(/url\.pathname\s*===\s*['"]([^'"]+)['"]/))) {
    const method = (lines.slice(Math.max(0, i - 3), i + 1).join(" ").match(/req\.method\s*===\s*['"](\w+)['"]/) || [])[1] || "?";
    routes.push({ line: i + 1, method, path: m[1] });
  }
  if ((m = l.match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/))) funcs.push({ line: i + 1, name: m[1] });
  if ((m = l.match(/^import\s+.*?from\s+['"]([^'"]+)['"]/))) imports.push({ line: i + 1, from: m[1] });
  if ((m = l.match(/^const\s+([A-Z0-9_]{3,})\s*=/))) consts.push({ line: i + 1, name: m[1] });
}

const md = [];
md.push("# bridge.js 索引（自动生成）", "");
md.push(`生成时间：${new Date().toISOString()}　总行数：**${lines.length}**`, "");
md.push("> 改代码前先查这里拿行号，再精读那一段。生成：`node scripts/map-bridge.mjs`", "");
md.push(`## HTTP 路由（${routes.length}）`, "", "| 行号 | 方法 | 路径 |", "| --- | --- | --- |");
for (const r of routes) md.push(`| ${r.line} | ${r.method} | \`${r.path}\` |`);
md.push("", `## 函数（${funcs.length}）`, "", "| 行号 | 名称 |", "| --- | --- |");
for (const f of funcs) md.push(`| ${f.line} | \`${f.name}\` |`);
md.push("", `## 模块导入（${imports.length}）`, "");
for (const im of imports) md.push(`- L${im.line} \`${im.from}\``);
md.push("", `## 顶层常量（${consts.length}）`, "");
md.push(consts.map((c) => `\`${c.name}\`(L${c.line})`).join(" · "), "");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md.join("\n"), "utf8");
console.log(`bridge-map.md 已生成：${routes.length} 路由 / ${funcs.length} 函数 / ${lines.length} 行`);