#!/usr/bin/env node
/**
 * Pixiv 取图 CLI（不经过 QQ，先验证接口能不能用）
 *
 * 用法：
 *   node tools/pixiv-cli.mjs --tag 蓝鲸                    # 搜全年龄，打印列表
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --limit 5
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --r18              # 连 R-18 一起（需要账号已允许）
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --download 2        # 下载前 2 个作品的第 1 张
 *   node tools/pixiv-cli.mjs --id 12345678 --download 1    # 直接按作品 id 下
 *
 * 输出永远带：标题 / 作者 / 分级 / 张数 / 作品链接 —— 转发别人作品时这是底线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detail, downloadImage, searchByTag, summarize, readAuth } from '../src/pixiv.js';

// Windows 中文路径在 URL 里是百分号编码的，必须用 fileURLToPath
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'pixiv');

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const has = (k) => argv.includes(k);

const tag = arg('--tag');
const id = arg('--id');
const limit = Number(arg('--limit', '10')) || 10;
const r18 = has('--r18');
const downloads = Number(arg('--download', '0')) || 0;

if (!tag && !id) {
  console.log('用法：node tools/pixiv-cli.mjs --tag <标签> [--limit 10] [--r18] [--download 2]');
  console.log('      node tools/pixiv-cli.mjs --id <作品id> [--download 1]');
  console.log('前提：先 node tools/pixiv-auth.mjs --login');
  process.exit(2);
}

if (!readAuth(STATE)?.refresh_token) {
  console.error('✗ 还没登录。先跑：node tools/pixiv-auth.mjs --login');
  process.exit(1);
}

try {
  let items = [];
  if (id) {
    items = [await detail(STATE, id)];
  } else {
    const r = await searchByTag({ stateDir: STATE, tag, limit, allowR18: r18 });
    items = r.items;
    console.log(`# 搜索「${tag}」：共 ${r.total} 条（全年龄 ${r.safeCount} / R-18 ${r.r18Count}），取前 ${items.length} 条`);
  }

  if (!items.length) {
    console.log('（没有结果。R-18 需要账号设置里允许显示，且加 --r18）');
    process.exit(0);
  }

  items.forEach((it, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${summarize(it)}`);
    if (it.tags?.length) console.log(`    标签: ${it.tags.slice(0, 6).join(' / ')}`);
  });

  if (downloads > 0) {
    console.log('');
    for (const it of items.slice(0, downloads)) {
      const first = it.pages[0];
      if (!first) { console.log(`   ✗ ${it.id} 没有图片地址`); continue; }
      const name = `pixiv-${it.id}-p1.jpg`;
      const r = await downloadImage(first, { outDir: OUT, name });
      console.log(`   ↓ ${it.id} → ${path.relative(ROOT, r.file)}（${Math.round(r.bytes / 1024)} KB）`);
      console.log(`     作者：${it.author}｜${it.link}`);
    }
    console.log(`\n下载目录：${path.relative(ROOT, OUT)}`);
  }
} catch (e) {
  console.error('✗ ' + (e?.message ?? e));
  process.exit(1);
}
