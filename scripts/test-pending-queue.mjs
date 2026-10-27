// 排队消息落盘/恢复（src/pending-queue.js）的契约测试。
//
// 为什么值得钉：这一层存在的意义就是"桥接重启不丢消息"。它如果写坏一次，
// 丢的是**用户的真实消息**且用户毫不知情 —— 所以序列化/反序列化/剪枝/容错都要有断言。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { serializeQueue, deserializeQueue, QUEUE_FILE_VERSION, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_PER_KEY } = await import(
  new URL('../src/pending-queue.js', import.meta.url).href
);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

const now = Date.parse('2026-10-28T00:00:00Z');

// ── 1. 序列化 ────────────────────────────────────────────────────────────
check('serializeQueue：只留能重投的字段，空文本/空会话不落盘', () => {
  const map = new Map([
    ['private:1', [
      { promptText: '你好', farewell: true, silent: false, media: [{ kind: 'image' }], wakeReason: 'at' },
      { promptText: '   ', }                        // 空文本 → 丢
    ]],
    ['group:2', []]                                   // 空会话 → 不落盘
  ]);
  const out = serializeQueue(map.entries(), { now });
  assert.equal(out.version, QUEUE_FILE_VERSION);
  assert.equal(out.count, 1);
  assert.deepEqual(Object.keys(out.items), ['private:1']);
  const item = out.items['private:1'][0];
  assert.equal(item.promptText, '你好');
  assert.equal(item.farewell, true);
  assert.equal(item.at, now, '应补上入队时间戳');
  assert.ok(!('silent' in item), 'false 的布尔字段不必落盘');
});

// ── 2. 反序列化：正常往返 ────────────────────────────────────────────────
check('deserializeQueue：serialize → deserialize 往返不丢内容', () => {
  const map = new Map([
    ['private:1', [{ promptText: 'a', at: now - 1000 }, { promptText: 'b', at: now - 500 }]],
    ['group:9', [{ promptText: 'c', at: now - 10, media: [{ kind: 'image', file: 'x.jpg' }] }]]
  ]);
  const json = JSON.stringify(serializeQueue(map.entries(), { now }));
  const back = deserializeQueue(json, { now });
  assert.equal(back.error, '');
  assert.equal(back.restored, 3);
  const asMap = new Map(back.entries);
  assert.equal(asMap.get('private:1').length, 2);
  assert.equal(asMap.get('private:1')[0].promptText, 'a');
  assert.equal(asMap.get('group:9')[0].media[0].file, 'x.jpg', 'media 要保留，否则补投会丢图');
});

// ── 3. 剪枝 ──────────────────────────────────────────────────────────────
check('deserializeQueue：超过 24 小时的消息丢掉并计数', () => {
  const json = JSON.stringify({
    version: QUEUE_FILE_VERSION,
    items: {
      'private:1': [
        { promptText: '旧', at: now - DEFAULT_MAX_AGE_MS - 1000 },
        { promptText: '新', at: now - 1000 }
      ]
    }
  });
  const back = deserializeQueue(json, { now });
  assert.equal(back.restored, 1);
  assert.equal(back.droppedExpired, 1);
  assert.equal(back.entries[0][1][0].promptText, '新');
});

check('deserializeQueue：每会话超量时保留最新的 N 条', () => {
  const list = Array.from({ length: DEFAULT_MAX_PER_KEY + 5 }, (_, i) => ({ promptText: `m${i}`, at: now - i }));
  const back = deserializeQueue(JSON.stringify({ version: QUEUE_FILE_VERSION, items: { 'private:1': list } }), { now });
  assert.equal(back.restored, DEFAULT_MAX_PER_KEY);
  assert.equal(back.droppedOverCap, 5);
  assert.equal(back.entries[0][1][0].promptText, 'm5', '留下的应该是最新的那些');
});

// ── 4. 容错：坏数据一律降级，不抛 ────────────────────────────────────────
check('deserializeQueue：坏 JSON / 空串 / 版本过新 / 缺 items 都降级成空队列并给原因', () => {
  assert.equal(deserializeQueue('').restored, 0, '空串应静默返回空');
  assert.match(deserializeQueue('{oops').error, /不是合法 JSON/);
  assert.match(deserializeQueue('null').error, /不是对象/);
  assert.match(deserializeQueue(JSON.stringify({ version: 999, items: {} })).error, /版本/);
  assert.match(deserializeQueue(JSON.stringify({ version: 1 })).error, /缺少 items/);
  // 带 BOM 的文件也要能读（Windows 编辑器常写 BOM）
  const bom = `\uFEFF${JSON.stringify({ version: 1, items: { 'private:1': [{ promptText: 'x', at: 1 }] } })}`;
  assert.equal(deserializeQueue(bom, { now: 2 }).restored, 1, 'BOM 不该让整份队列作废');
});

check('deserializeQueue：未来时间戳（时钟回拨）拉回现在，而不是当成"还有很久"', () => {
  const json = JSON.stringify({ version: 1, items: { 'private:1': [{ promptText: 'x', at: now + 86400000 }] } });
  const back = deserializeQueue(json, { now });
  assert.equal(back.entries[0][1][0].at, now);
});

// ── 5. 接线 ──────────────────────────────────────────────────────────────
check('bridge：每次队列变更都落盘，启动恢复，DSH 就绪后主动补投', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /from '\.\/pending-queue\.js'/);
  assert.match(bridge, /const persistQueueSoon = \(\) =>/, '要有 debounce 落盘');
  assert.match(bridge, /const restoreQueueFromDisk = \(\) =>/, '要有启动恢复');
  assert.match(bridge, /restoreQueueFromDisk\(\);/, '启动时要真的调用它');
  assert.match(bridge, /\.tmp`/, '要写临时文件再 rename（原子替换）');
  // 所有 queued.set / queued.delete 之后都应该有落盘
  const mutations = [...bridge.matchAll(/queued\.(set|delete)\([^\n]*\n/g)];
  assert.ok(mutations.length >= 5, `队列变更点太少（${mutations.length}），是不是漏了`);
  const withPersist = [...bridge.matchAll(/queued\.(set|delete)\([^\n]*\n\s*persistQueueSoon\(\);/g)];
  assert.ok(withPersist.length >= 5, `有 ${mutations.length} 处变更但只有 ${withPersist.length} 处落盘`);
  assert.match(bridge, /DSH 已就绪，开始补投/, '就绪后要主动补投恢复的队列');
  // 全成功时内存队列会 clear()，磁盘若不跟着写 → 下次重启重复投递（真实踩过）
  assert.match(bridge, /flush 结束时\*\*必须\*\*落盘一次/, '要在 flush 的 finally 里落盘');
  // 注意：不能用 indexOf('flushingQueue = false;') —— 模块顶部还有 `let flushingQueue = false;`，
  // 会切到声明处去（第一次就踩了）。改成以那句注释为锚点向后看。
  const markerAt = bridge.indexOf('flush 结束时');
  assert.ok(markerAt > 0, '找不到那句注释（是不是被改写了？）');
  assert.match(bridge.slice(markerAt, markerAt + 400), /persistQueueSoon\(\);/, 'finally 里必须有 persistQueueSoon()');

});

check('落盘文件放在 state/ 下（gitignore，不会把用户消息提交进仓库）', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /state', 'pending-queue\.json'/, '必须落在 state/ 目录');
  const gi = read('.gitignore');
  assert.match(gi, /^state\/$/m, 'state/ 必须被 gitignore');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
