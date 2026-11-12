// 抖音链接识别增强（src/douyin-link.js）的离线测试。
//
// 为什么要有：群里最常见的不是裸链接，而是「7.92 复制打开抖音，看看【xx的作品】…
// https://v.douyin.com/xxxx/ 复制此链接」这种夹在文案里的分享串。
// 之前 bridge.js 只有 v.douyin.com|www.douyin.com/video 一条正则，
// iesdouyin 分享页、discover?modal_id、图文 note 都会漏掉。
// 这里把形态钉死，改正则时先看它。

import assert from 'node:assert/strict';
import { extractDouyinLinks, awemeIdFromLink, formatDouyinCard, createDouyinLinkDeduper } from '../src/douyin-link.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

check('短链', () => {
  const links = extractDouyinLinks('看这个 https://v.douyin.com/iRNBho6u/ 笑死');
  assert.equal(links.length, 1);
  assert.ok(links[0].startsWith('https://v.douyin.com/iRNBho6u'));
});

check('标准视频页（带查询串）', () => {
  const links = extractDouyinLinks('https://www.douyin.com/video/7697926023714737408?previous_page=app_code_link');
  assert.equal(links.length, 1);
  assert.equal(awemeIdFromLink(links[0]), '7697926023714737408');
});

check('iesdouyin 分享页', () => {
  const links = extractDouyinLinks('https://www.iesdouyin.com/share/video/7700660682928967397/?region=CN');
  assert.equal(awemeIdFromLink(links[0]), '7700660682928967397');
});

check('discover?modal_id', () => {
  const links = extractDouyinLinks('https://www.douyin.com/discover?modal_id=7700660682928967397');
  assert.equal(awemeIdFromLink(links[0]), '7700660682928967397');
});

check('分享文案里夹的链接', () => {
  const text = '7.92 复制打开抖音，看看【居居罗的作品】#跨次元沟通 https://v.douyin.com/abc-DEF_12/ 复制此链接';
  const links = extractDouyinLinks(text);
  assert.equal(links.length, 1);
});

check('一条消息里多个链接', () => {
  const links = extractDouyinLinks('两个 https://v.douyin.com/aaa/ 和 https://www.douyin.com/video/7700660682928967397');
  assert.equal(links.length, 2);
});

check('非抖音链接不抓', () => {
  assert.equal(extractDouyinLinks('https://www.bilibili.com/video/BV1xx411c7mD').length, 0);
  assert.equal(extractDouyinLinks('没有链接').length, 0);
});

check('卡片文本带作者/时长/互动/id', () => {
  const card = formatDouyinCard({
    ok: true, author: '居居罗', title: '跨次元沟通', durationSec: 21,
    stats: { digg_count: 13, comment_count: 3, share_count: 2, collect_count: 5 }
  }, 'https://www.douyin.com/video/7700660682928967397');
  assert.ok(card.includes('@居居罗'));
  assert.ok(card.includes('21 秒'));
  assert.ok(card.includes('赞13'));
  assert.ok(card.includes('7700660682928967397'));
});

check('解析失败时卡片为空（安静降级）', () => {
  assert.equal(formatDouyinCard({ ok: false, error: 'x' }), '');
});

check('去重：同群同视频只第一次 true，不同群互不影响', () => {
  const d = createDouyinLinkDeduper(1000);
  assert.equal(d.hit('g1|770'), true);
  assert.equal(d.hit('g1|770'), false);
  assert.equal(d.hit('g2|770'), true);
});

console.log(`\n抖音链接增强：${n} 项通过`);
