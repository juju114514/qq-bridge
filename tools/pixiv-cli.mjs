#!/usr/bin/env node
/**
 * Pixiv 取图 CLI（网页接口版，免登录可搜全年龄）
 *
 * 用法：
 *   node tools/pixiv-cli.mjs --tag 蓝鲸                 # 搜全年龄，打印列表
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --limit 5
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --download 2    # 下载前 2 个作品
 *   node tools/pixiv-cli.mjs --id 131946065 --download 1
 *   node tools/pixiv-cli.mjs --tag 蓝鲸 --r18           # 连 R-18 一起（需要 cookies）
 *   node tools/pixiv-cli.mjs --cookies                 # 看 cookie 状态
 *
 * R-18 需要 state/pixiv-cookies.txt（Netscape 格式）：
 *   python room-pet/export_cookies.py --port 9237 --out state/pixiv-cookies.txt
 *   （前提：那个调试浏览器里登录过 pixiv）
 *
 * 输出永远带 标题 / 作者 / 分级 / 张数 / 作品链接。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCookies, searchWeb, illustUrls, downloadImage, summarize, COOKIE_FILE } from '../src/pixiv-web.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'pixiv');

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : ''; };
const has = (k) => argv.includes(k);

if (has('--cookies')) {
  const ok = hasCookies(STATE);
  console.log(ok ? `✓ 有 cookies：${path.relative(ROOT, COOKIE_FILE(STATE))}` : `✗ 没有 cookies（只能搜全年龄）\n  需要 R-18：python room-pet/export_cookies.py --port 9237 --out state/pixiv-cookies.txt`);
  process.exit(ok ? 0 : 1);
}

const tag = arg('--tag');
const id = arg('--id');
const limit = Number(arg('--limit', '10')) || 10;
const wantR18 = has('--r18');
const downloads = Number(arg('--download', '0')) || 0;

if (!tag && !id) {
  console.log('用法：node tools/pixiv-cli.mjs --tag <标签> [--limit 10] [--r18] [--download 2]');
  console.log('      node tools/pixiv-cli.mjs --id <作品id> [--download 1]');
  console.log('      node tools/pixiv-cli.mjs --cookies');
  process.exit(2);
}

try {
  let items = [];
  if (id) {
    const d = await illustUrls(STATE, id);
    items = [{
      id: d.id, title: d.title, author: d.author,
      grade: d.xRestrict >= 2 ? 'r18g' : d.xRestrict === 1 ? 'r18' : 'safe',
      tags: d.tags, pageCount: d.pageCount, link: `https://www.pixiv.net/artworks/${d.id}`
    }];
  } else {
    const r = await searchWeb({ stateDir: STATE, tag, limit, mode: wantR18 ? 'r18' : 'all' });
    items = r.items;
    console.log(`# 搜索「${tag}」：共 ${r.total} 条，取前 ${items.length} 条${r.loggedIn ? '' : '（未登录，只能看全年龄）'}`);
  }

  if (!items.length) {
    console.log('（没有结果。R-18 需要 cookies + --r18）');
    process.exit(0);
  }

  items.forEach((it, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${summarize(it)}`);
    if (it.tags?.length) console.log(`    标签: ${it.tags.slice(0, 6).join(' / ')}`);
  });

  if (downloads > 0) {
    console.log('');
    for (const it of items.slice(0, downloads)) {
      const d = await illustUrls(STATE, it.id);
      const first = d.urls?.[0];
      if (!first) { console.log(`   ✗ ${it.id} 没拿到原图地址（R-18 需要 cookies）`); continue; }
      const r = await downloadImage(first, { outDir: OUT, name: `pixiv-${it.id}-p1.jpg` });
      console.log(`   ↓ ${it.id} → ${path.relative(ROOT, r.file)}（${Math.round(r.bytes / 1024)} KB）`);
      console.log(`     作者：${it.author}｜${it.link}`);
    }
    console.log(`\n下载目录：${path.relative(ROOT, OUT)}`);
  }
} catch (e) {
  console.error('✗ ' + (e?.message ?? e));
  process.exit(1);
}
