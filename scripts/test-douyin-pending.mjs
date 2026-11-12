// 「要不要下载这条抖音视频」的判断测试（src/douyin-pending.js）。
//
// 这条规则的商业价值是「别乱下」：下载是风控高危动作，
// 默认只附元数据，群友明说要视频才走下载通道。
// 所以测试重点不是"能匹配多少说法"，而是**不能把闲聊误判成要视频**。

import assert from 'node:assert/strict';
import { matchDownloadRequest, createDouyinPendingStore, buildDownloadHint } from '../src/douyin-pending.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

check('明说要视频的几种说法', () => {
  for (const t of ['发视频', '发一下视频', '发来看看', '下载这个', '我要看这个视频', '放一下看看', '传个视频']) {
    assert.equal(matchDownloadRequest(t), true, t);
  }
});

check('闲聊不能误判', () => {
  for (const t of ['今天吃啥', '这个视频不错啊哈哈真的挺好看的我觉得', '在吗', '']) {
    assert.equal(matchDownloadRequest(t), false, t);
  }
});

check('否定句不触发', () => {
  for (const t of ['别下', '不要发视频', '不用发']) {
    assert.equal(matchDownloadRequest(t), false, t);
  }
});

check('太长的不当要求（阈值 60 字）', () => {
  const long = '发视频'.repeat(30);
  assert.equal(matchDownloadRequest(long), false);
});

check('pending 存取 + 过期', () => {
  const s = createDouyinPendingStore(50);
  s.remember('group:1', { url: 'https://v.douyin.com/x/', id: '770' });
  assert.equal(s.take('group:1').id, '770');
  assert.equal(s.take('group:2'), null);
});

check('过期后取不到', async () => {
  const s = createDouyinPendingStore(1);
  s.remember('group:1', { url: 'https://v.douyin.com/x/' });
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(s.take('group:1'), null);
});

check('下载提示里带链接与 mode 说明', () => {
  const hint = buildDownloadHint({ url: 'https://v.douyin.com/abc/', title: '跨次元' });
  assert.ok(hint.includes('https://v.douyin.com/abc/'));
  assert.ok(hint.includes('群友要视频'));
  assert.ok(hint.includes('后台已经在下载'));
});

check('没有链接时提示为空（安静降级）', () => {
  assert.equal(buildDownloadHint({}), '');
  assert.equal(buildDownloadHint(null), '');
});

console.log(`\n抖音下载闸门：${n} 项通过`);
