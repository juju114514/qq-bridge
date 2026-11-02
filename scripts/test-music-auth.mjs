// 音乐账号登录（0.4.135）：二维码协议解析 + 登录态
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/music-auth.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('hash33：已知输入稳定输出，且非负', () => {
  const a = m.hash33('abc');
  assert.equal(typeof a, 'number');
  assert.ok(a >= 0, 'hash33 不能为负');
  assert.equal(m.hash33('abc'), a, '同一输入必须稳定');
  assert.equal(m.hash33(''), 0);
});

await check('hash33：长串不溢出成负数', () => {
  for (const s of ['a'.repeat(200), '0222a95952c75ca74f46446fa60af128', '中文也要能算']) {
    const v = m.hash33(s);
    assert.ok(Number.isInteger(v) && v >= 0, `${s.slice(0, 8)} 得到 ${v}`);
  }
});

await check('parsePtuiCB：成功（code 0，带昵称）', () => {
  const r = m.parsePtuiCB("ptuiCB('0','0','https://ptlogin2.qq.com/check_sig?uin=123','0','登录成功','小鲸鱼')");
  assert.equal(r.code, 0);
  assert.equal(r.nickname, '小鲸鱼');
  assert.match(r.url, /uin=123/);
});

await check('parsePtuiCB：已扫码待确认（65）/ 未失效（66）/ 已失效（67）', () => {
  assert.equal(m.parsePtuiCB("ptuiCB('65','0','','0','已扫码','')").code, 65);
  assert.equal(m.parsePtuiCB("ptuiCB('66','0','','0','未失效','')").code, 66);
  assert.equal(m.parsePtuiCB("ptuiCB('67','0','','0','已失效','')").code, 67);
});

await check('parsePtuiCB：不是回调就返回 raw，不抛', () => {
  const r = m.parsePtuiCB('<html>error</html>');
  assert.equal(r.code, null);
  assert.match(r.raw, /html/);
});

await check('writeCookieFile：按 resolver 认的格式写 k=v; k2=v2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-music-'));
  const f = path.join(dir, 'netmusic-cookie.txt');
  m.writeCookieFile(f, 'MUSIC_U=abc; __csrf=def');
  assert.equal(fs.readFileSync(f, 'utf8').trim(), 'MUSIC_U=abc; __csrf=def');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('neteaseStart：从 unikey 拼出二维码内容', async () => {
  const auth = m.createMusicAuth({
    stateFile: path.join(os.tmpdir(), 'qqb-music-state.json'),
    fetchImpl: async () => ({ json: async () => ({ code: 200, unikey: 'KEY-123' }) })
  });
  const s = await auth.start('netease');
  assert.equal(s.key, 'KEY-123');
  assert.equal(s.qrText, 'https://music.163.com/login?codekey=KEY-123');
});

await check('neteasePoll：801→waiting / 802→scanned / 803→ok 并落 cookie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-music-'));
  const stateFile = path.join(dir, 'state.json');
  const mk = (code, extra = {}) => m.createMusicAuth({
    stateFile,
    fetchImpl: async () => ({ json: async () => ({ code, message: '', ...extra }) })
  });
  assert.equal((await mk(801).poll('netease', 'k')).state, 'waiting');
  assert.equal((await mk(802).poll('netease', 'k')).state, 'scanned');
  assert.equal((await mk(800).poll('netease', 'k')).state, 'expired');

  const ok = await mk(803, { cookie: 'MUSIC_U=xyz' }).poll('netease', 'k');
  assert.equal(ok.state, 'ok');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.netease.cookie, 'MUSIC_U=xyz');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('qqPoll：66→waiting / 65→scanned / 67→expired / 0→ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-music-'));
  const stateFile = path.join(dir, 'state.json');
  const mk = (cb) => m.createMusicAuth({
    stateFile,
    fetchImpl: async () => ({
      text: async () => cb,
      headers: { getSetCookie: () => ['uin=o001; path=/', 'skey=abc; path=/'] }
    })
  });
  assert.equal((await mk("ptuiCB('66','0','','0','','')").poll('qq', 'sig')).state, 'waiting');
  assert.equal((await mk("ptuiCB('65','0','','0','','')").poll('qq', 'sig')).state, 'scanned');
  assert.equal((await mk("ptuiCB('67','0','','0','','')").poll('qq', 'sig')).state, 'expired');

  const ok = await mk("ptuiCB('0','0','https://ptlogin2.qq.com/check_sig?uin=10001','0','登录成功','阿明')").poll('qq', 'sig');
  assert.equal(ok.state, 'ok');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.match(saved.qq.cookie, /qrsig=sig/);
  assert.equal(saved.qq.nickname, '阿明');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('status：没登录时两个平台都是未登录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-music-'));
  const auth = m.createMusicAuth({ stateFile: path.join(dir, 'state.json'), fetchImpl: async () => ({ json: async () => ({}) }) });
  const st = await auth.status();
  assert.equal(st.netease.loggedIn, false);
  assert.equal(st.qq.loggedIn, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('logout：清掉指定平台', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-music-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ netease: { cookie: 'a' }, qq: { cookie: 'b', uin: '1' } }));
  const auth = m.createMusicAuth({ stateFile, fetchImpl: async () => ({ json: async () => ({}) }) });
  await auth.logout('netease');
  const left = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(left.netease, undefined);
  assert.ok(left.qq, 'qq 不该被一起清掉');
  fs.rmSync(dir, { recursive: true, force: true });
});


await check('netease：轮询必须带上 unikey 会话 cookie（否则确认阶段 8821）', async () => {
  const calls = [];
  const auth = m.createMusicAuth({
    stateFile: path.join(os.tmpdir(), 'qqb-music-sess.json'),
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url, cookie: opts.headers?.cookie || '' });
      if (String(url).includes('unikey')) {
        return {
          json: async () => ({ code: 200, unikey: 'K1' }),
          headers: { getSetCookie: () => ['NMTID=abc; Path=/'] }
        };
      }
      return { json: async () => ({ code: 801, message: '等待扫码' }) };
    }
  });
  await auth.start('netease');
  await auth.poll('netease', 'K1');
  assert.equal(calls.length, 2);
  assert.match(calls[1].cookie, /NMTID=abc/, '轮询没带上会话 cookie');
});

await check('netease：8821 视为 waiting 并给 slowDown 标记', async () => {
  const auth = m.createMusicAuth({
    stateFile: path.join(os.tmpdir(), 'qqb-music-8821.json'),
    fetchImpl: async () => ({ json: async () => ({ code: 8821, message: '' }) })
  });
  const r = await auth.poll('netease', 'K');
  assert.equal(r.state, 'waiting');
  assert.equal(r.slowDown, true);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
