const BASE = 'http://127.0.0.1:3000';
const TOKEN = 'eFO8u-qEFYFq6YWDtQshgpoM0y3tLZLE8xj4F4THQEo';
const OWNER = '1599683156';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, query = '', body = null) {
  const url = `${BASE}/${action}?access_token=${TOKEN}${query}`;
  const opt = { headers: { Authorization: `Bearer ${TOKEN}` } };
  if (body) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

function pickFlag(req) {
  for (const k of ['flag', 'id', 'request_id', 'seq', 'messageId', 'msg_id']) {
    if (req && req[k]) return String(req[k]);
  }
  return null;
}

console.log(`[watch] started ${new Date().toLocaleTimeString('zh-CN')} — 等待 ${OWNER} 的好友申请`);
let found = false;
for (let i = 1; i <= 120 && !found; i++) {
  try {
    const r = await call('get_doubt_friends_add_request', '&count=50');
    const list = Array.isArray(r?.data) ? r.data : [];
    if (list.length) {
      found = true;
      console.log('=== 待处理请求 ===');
      console.log(JSON.stringify(list, null, 2));
      for (const req of list) {
        const flag = pickFlag(req);
        if (!flag) {
          console.log('!! 没有可用 flag 字段，需人工在小号 QQ 上同意');
          continue;
        }
        for (const action of ['set_friend_add_request', 'set_doubt_friends_add_request']) {
          const r2 = await call(action, '', { flag, approve: true });
          console.log(`[approve] ${action} flag=${flag} -> ${JSON.stringify(r2)}`);
          if (r2?.retcode === 0 && r2?.status === 'ok') break;
        }
      }
      const fl = await call('get_friend_list');
      console.log('=== 好友列表 ===');
      console.log(JSON.stringify(fl?.data ?? fl));
      break;
    }
  } catch (e) {
    console.log(`poll ${i} error: ${e.message}`);
  }
  await sleep(5000);
}
console.log(`[watch] done ${new Date().toLocaleTimeString('zh-CN')} found=${found}`);
// snapshot test 220036
