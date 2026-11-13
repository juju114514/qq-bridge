// 深夜房间 · 互动版
// 状态机 + 交互：摸头 / 捏脸 / 抱抱 / 喂饭 / 陪看书 / 聊天 / 时钟
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const stage = $('stage');
  const pet = $('pet');
  const wrap = $('petWrap');
  const bubble = $('bubble');
  const bubbleText = $('bubbleText');
  const hearts = $('hearts');
  const clockEl = $('clock');
  const moodEl = $('mood');

  const A = 'assets/character/';
  const FRAME = {
    idle: A + 'idle.png',
    blink: A + 'blink.png',
    listening: A + 'listening.png',
    petting: A + 'petting.png',
    pinch_left: A + 'pinch_left.png',
    pinch_right: A + 'pinch_right.png',
    annoyed_1: A + 'annoyed_1.png',
    annoyed_2: A + 'annoyed_2.png',
    annoyed_3: A + 'annoyed_3.png',
    crying: A + 'crying.png',
    asking_hug: A + 'asking_hug.png',
    hugging: A + 'hugging.png',
    feeding_ready: A + 'feeding_ready.png',
    feeding_base: A + 'feeding_base.png',
    feeding_chew: A + 'feeding_chew.png',
    study: A + 'study.png',
    study_tired: A + 'study_tired.png',
  };

  // 预加载，避免切帧闪
  Object.values(FRAME).forEach(src => { const i = new Image(); i.src = src; });

  let state = 'idle';
  let mood = 6;              // 0-10
  let annoyed = 0;           // 捏脸次数
  let petCount = 0;
  let bubbleTimer = null;
  let blinkTimer = null;
  let idleTimer = null;
  let studyTimer = null;
  let feeding = false;
  let huggingTimer = null;

  const lines = {
    idle: [
      '……今天也这么晚啊。',
      '窗外好像在飘雪。',
      '台灯有点暖。',
      '你忙你的，我不吵你。',
      '要不要听首安静的？',
      '手机快没电了……',
    ],
    petting: ['唔……舒服。', '再摸一会儿嘛。', '嘿嘿。', '头发要乱了啦。'],
    annoyed: ['别捏了……', '再捏我要生气了。', '疼！', '哼。'],
    crying: ['呜……你欺负人。', '不理你了。'],
    hugging: ['抱抱……暖和。', '就一下下哦。'],
    feeding: ['啊——', '嗯，好吃。', '还要。'],
    study: ['一起看书吧。', '这页我看完了。'],
    tired: ['眼睛好酸……', '困了。'],
  };

  // ---------------- 状态切换
  function setState(next, opts = {}) {
    const prev = state;
    state = next;
    stage.dataset.state = next;
    pet.src = FRAME[next] || FRAME.idle;
    document.title = '深夜房间 · ' + next;
    if (next === 'hugging') {
      clearTimeout(huggingTimer);
      huggingTimer = setTimeout(() => setState('idle'), opts.hold || 2200);
    }
  }

  function say(text, hold) {
    if (!text) return;
    bubbleText.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), hold || Math.max(2600, text.length * 170));
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ---------------- 心情
  function setMood(v) {
    mood = Math.max(0, Math.min(10, v));
    const shown = Math.round(mood * 10) / 10;
    moodEl.innerHTML = `心情 <b>${shown}</b>/10`;
  }

  // ---------------- 眨眼
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (state === 'idle') {
        pet.src = FRAME.blink;
        setTimeout(() => { if (state === 'idle') pet.src = FRAME.idle; }, 130);
      }
      scheduleBlink();
    }, 2600 + Math.random() * 3200);
  }

  // ---------------- 闲聊
  function scheduleIdleTalk() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state === 'idle') say(pick(lines.idle));
      scheduleIdleTalk();
    }, 40000 + Math.random() * 40000);
  }

  // ---------------- 视线跟随
  document.addEventListener('mousemove', e => {
    if (state === 'hugging' || state === 'crying') return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = (e.clientX - cx) / cx;   // -1..1
    const dy = (e.clientY - cy) / cy;
    wrap.style.transform = `translateX(-50%) translate(${dx * 10}px, ${dy * 6}px)`;
  });

  // ---------------- 热区
  function makeHit(cls, handlers) {
    const d = document.createElement('div');
    d.className = 'hit ' + cls;
    Object.entries(handlers).forEach(([k, fn]) => d.addEventListener(k, fn));
    wrap.appendChild(d);
    return d;
  }

  // 摸头：点一下进入 petting，1.6 秒后回 idle
  makeHit('head', {
    click: e => {
      e.preventDefault();
      petCount++;
      setState('petting');
      say(pick(lines.petting), 1600);
      setMood(mood + 0.4);
      spawnHearts(3);
      if (annoyed > 0) annoyed = Math.max(0, annoyed - 1);
      setTimeout(() => { if (state === 'petting') setState('idle'); }, 1600);
    },
  });

  // 捏脸：左右脸，越捏越恼
  function pinch(side) {
    annoyed++;
    setMood(mood - 0.5);
    const frame = side === 'left' ? 'pinch_left' : 'pinch_right';
    setState(frame);
    if (annoyed >= 6) {
      setState('crying');
      say(pick(lines.crying), 3200);
    } else if (annoyed >= 3) {
      setState('annoyed_' + Math.min(3, annoyed - 2));
      say(pick(lines.annoyed), 2200);
    } else {
      say('唔……', 1200);
    }
    setTimeout(() => {
      if (state.startsWith('pinch') || state.startsWith('annoyed')) setState('idle');
    }, 800);
  }
  makeHit('cheek-left', { click: () => pinch('left') });
  makeHit('cheek-right', { click: () => pinch('right') });

  // ---------------- 爱心粒子
  function spawnHearts(n) {
    for (let i = 0; i < n; i++) {
      const h = document.createElement('div');
      h.className = 'heart';
      h.textContent = '♥';
      h.style.left = (35 + Math.random() * 30) + '%';
      h.style.top = (10 + Math.random() * 20) + '%';
      h.style.animationDelay = (Math.random() * 0.25) + 's';
      hearts.appendChild(h);
      setTimeout(() => h.remove(), 1400);
    }
  }

  // ---------------- 动作按钮
  document.querySelector('.actions').addEventListener('click', e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'hug') {
      setState('asking_hug');
      say('要抱抱吗？', 1200);
      setTimeout(() => { setState('hugging'); say(pick(lines.hugging), 2200); setMood(mood + 1.2); }, 900);
    }
    if (act === 'feed') {
      if (feeding) return;
      feeding = true;
      setState('feeding_ready');
      say('啊——张嘴。', 1500);
      setTimeout(() => {
        setState('feeding_base');
        setTimeout(() => {
          setState('feeding_chew');
          say(pick(lines.feeding), 1600);
          setMood(mood + 1);
          setTimeout(() => { setState('idle'); feeding = false; }, 2200);
        }, 1200);
      }, 900);
    }
    if (act === 'study') {
      startStudy(25);
    }
    if (act === 'chat') {
      const box = $('chatBox');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) $('chatInput').focus();
    }
  });

  // ---------------- 陪看书
  function startStudy(minutes) {
    setState('study');
    say(`陪你 ${minutes} 分钟。`, 2000);
    clearTimeout(studyTimer);
    const total = minutes * 60 * 1000;
    studyTimer = setTimeout(() => {
      setState('study_tired');
      say(pick(lines.tired), 3000);
      setMood(mood + 0.8);
      setTimeout(() => setState('idle'), 3500);
    }, Math.min(total, 120 * 60 * 1000));
  }

  // ---------------- 聊天（本地回显；外部可调 window.roomPet.say）
  async function sendChat() {
    const input = $('chatInput');
    let text = input.value.trim();
    if (!text && !__visionImage) return;
    input.value = '';
    setState('listening');
    if (__visionImage) {
      say('我看看画面…', 1800);
      const v = await visionDescribe(__visionImage);
      __visionImage = null;
      const thumb = document.getElementById('visionThumb');
      if (thumb) thumb.style.display = 'none';
      if (v.ok && v.text) text = '（我看到画面：' + v.text + '）\n' + text;
      else say(v.error || '没看清画面', 2400);
    }
    say('嗯……' + text.slice(0, 20), 1500);
    setTimeout(() => {
      const reply = localReply(text);
      setState('idle');
      say(reply, 4200);
      setMood(mood + 0.3);
    }, 700);
  }

  function localReply(text) {
    if (/累|困|睡/.test(text)) return '那就早点休息吧，我在这儿。';
    if (/吃|饭|饿/.test(text)) return '我还不饿……你要不要吃点东西？';
    if (/你好|在吗/.test(text)) return '在的。深夜好。';
    if (/歌|音乐/.test(text)) return '想听安静一点的，还是热闹一点的？';
    if (/抱|摸/.test(text)) return '嘿嘿……可以再摸一下。';
    return '嗯，我记下了。';
  }

  $('chatSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // ---------------- 时钟
  function tickClock() {
    const d = new Date();
    clockEl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ---------------- 深夜状态
  function checkNight() {
    const h = new Date().getHours();
    if (h >= 1 && h < 6) stage.dataset.night = 'deep';
  }
  checkNight();

  // ---------------- 对外接口（后续接 AI / 桥接）
  window.roomPet = {
    say,
    setState,
    setMood,
    get state() { return state; },
    get mood() { return mood; },
  };

  // 调试：按 d 显示热区
  document.addEventListener('keydown', e => {
    if (e.key === 'd' || e.key === 'D') stage.classList.toggle('debug');
  });



  // 外部状态：服务端 SSE（/events），在 http 下才连

  // ── 按住说话（录音 → /asr → 填进聊天框）──
  let __rec = null, __chunks = [], __stream = null;
  async function startRec(e) {
    e?.preventDefault?.();
    if (__rec) return;
    try {
      __stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      __chunks = [];
      __rec = new MediaRecorder(__stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
      __rec.ondataavailable = ev => { if (ev.data && ev.data.size) __chunks.push(ev.data); };
      __rec.onstop = async () => {
        const blob = new Blob(__chunks, { type: 'audio/webm' });
        try { __stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        __stream = null; __rec = null;
        say('听写中…', 1500);
        try {
          const r = await fetch('/asr', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob });
          const d = await r.json();
          if (d.ok && d.text) {
            const input = document.getElementById('chatInput');
            input.value = d.text;
            say('听到了：' + d.text, 2600);
            input.focus();
          } else {
            say(d.error || '没听清', 2600);
          }
        } catch (err) { say('ASR 请求失败', 2400); }
      };
      __rec.start();
      say('正在听…', 1200);
    } catch (err) {
      say('麦克风打不开：' + (err && err.message ? err.message : err), 2600);
    }
  }
  function stopRec(e) {
    e?.preventDefault?.();
    if (__rec && __rec.state === 'recording') __rec.stop();
  }
  const mic = document.getElementById('micBtn');
  if (mic) {
    mic.addEventListener('mousedown', startRec);
    mic.addEventListener('touchstart', startRec, { passive: false });
    mic.addEventListener('mouseup', stopRec);
    mic.addEventListener('mouseleave', stopRec);
    mic.addEventListener('touchend', stopRec);
  }


  // ── 视觉：摄像头 / 屏幕 → 一帧 → 本地视觉模型描述 ──
  let __camStream = null, __visionImage = null;

  function __grab(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    __visionImage = c.toDataURL('image/jpeg', 0.75);
    const thumb = document.getElementById('visionThumb');
    if (thumb) { thumb.src = __visionImage; thumb.style.display = 'block'; }
    say('画面记下了，发消息时会一起看', 2200);
  }

  async function visionCapture(kind) {
    try {
      if (kind === 'screen') {
        const st = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const v = document.createElement('video');
        v.srcObject = st; await v.play();
        await new Promise(r => setTimeout(r, 500));
        __grab(v);
        st.getTracks().forEach(t => t.stop());
      } else {
        if (!__camStream) {
          __camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        }
        const v = document.createElement('video');
        v.srcObject = __camStream; v.muted = true; await v.play();
        await new Promise(r => setTimeout(r, 400));
        __grab(v);
      }
    } catch (e) {
      say('拿不到画面：' + (e.message || e), 2600);
    }
  }

  async function visionDescribe(dataUrl) {
    try {
      const r = await fetch('/vision/describe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });
      return await r.json();
    } catch (e) { return { ok: false, error: '视觉请求失败' }; }
  }

  document.getElementById('visionCam')?.addEventListener('click', () => visionCapture('cam'));
  document.getElementById('visionScreen')?.addEventListener('click', () => visionCapture('screen'));


  // ── 记忆抽屉 ──
  async function memLoad() {
    const list = document.getElementById('memList');
    if (!list) return;
    try {
      const [items, score] = await Promise.all([
        fetch('/memory').then(r => r.json()),
        fetch('/memory/score').then(r => r.json())
      ]);
      const sc = document.getElementById('memScore');
      if (sc && score.ok) sc.textContent = score.score + '/100';
      const arr = items.items || [];
      list.innerHTML = arr.length ? arr.map(it => `
        <div class="mem-item" data-id="${it.id}">
          <div class="m">${it.tag ? '#' + it.tag + ' · ' : ''}${it.at || ''}</div>
          <div class="t">${String(it.text || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>
          <div class="o"><button class="e">编辑</button><button class="d">删</button></div>
        </div>`).join('') : '<div style="color:#8ea0bd;font-size:12px">还没有记忆</div>';
      list.querySelectorAll('.mem-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('.e').onclick = async () => {
          const cur = el.querySelector('.t').textContent;
          const v = prompt('修改这条记忆：', cur);
          if (v == null || !v.trim()) return;
          await fetch('/memory', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text: v.trim() }) });
          memLoad();
        };
        el.querySelector('.d').onclick = async () => {
          if (!confirm('删掉这条记忆？')) return;
          await fetch('/memory?id=' + encodeURIComponent(id), { method: 'DELETE' });
          memLoad();
        };
      });
    } catch (e) { /* 忽略 */ }
  }

  const memToggle = document.getElementById('memToggle');
  const memDrawer = document.getElementById('memDrawer');
  if (memToggle && memDrawer) {
    memToggle.addEventListener('click', () => {
      memDrawer.classList.toggle('open');
      if (memDrawer.classList.contains('open')) memLoad();
    });
    document.getElementById('memClose').addEventListener('click', () => memDrawer.classList.remove('open'));
    document.getElementById('memAdd').addEventListener('click', async () => {
      const inp = document.getElementById('memInput');
      const v = inp.value.trim();
      if (!v) return;
      await fetch('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: v }) });
      inp.value = '';
      memLoad();
    });
  }

  function connectState() {
    if (!window.EventSource || location.protocol !== 'http:') return;
    const es = new EventSource('http://127.0.0.1:8796/events');
    es.onmessage = e => {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      const st = d.state || 'idle';
      const text = (d.text || '').trim();
      if (st === 'thinking') {
        setState('listening');
        say(text || '……让我想想。', 2400);
        setTimeout(() => { if (state === 'listening') setState('idle'); }, 2400);
      } else if (st === 'speaking') {
        speak(text);
        setState('listening');
        say(text || '……', 2600);
        setTimeout(() => { if (state === 'listening') setState('idle'); }, 2600);
      } else if (st === 'peer_say') {
        const [from, ...rest] = (d.text || '').split('|');
        const msg = rest.join('|');
        stage.classList.add('peer-look');
        setTimeout(() => stage.classList.remove('peer-look'), 1000);
        setState('listening');
        say(`${from} 说：${msg}`, 3000);
        setTimeout(() => { if (state === 'listening') setState('idle'); }, 3000);
      } else if (st === 'sleep') {
        setState('idle');
        say('晚安……', 2600);
      } else {
        setState('idle');
      }
    };
    es.onerror = () => { es.close(); setTimeout(connectState, 2000); };
  }
  connectState();


  // 外部 TTS：说这句话（失败静默，不影响画面）
  let __ttsAudio = null;
  function speak(text) {
    if (!text) return;
    try {
      if (!__ttsAudio) __ttsAudio = new Audio();
      try { __ttsAudio.pause(); __ttsAudio.currentTime = 0; } catch (_) {}
      fetch('/tts?stream=1&text=' + encodeURIComponent(text))
        .then(r => r.ok ? r.blob() : Promise.reject(new Error('tts ' + r.status)))
        .then(b => { __ttsAudio.src = URL.createObjectURL(b); __ttsAudio.play().catch(() => {}); })
        .catch(() => {});
    } catch (_) {}
  }
  window.roomPetSpeak = speak;

  // ── 在线朋友（局域网） ─────────────────────────────────────────
  const API_BASE = location.pathname.startsWith('/room-pet') ? 'http://127.0.0.1:8796' : '';
  const friendsList = $('friendsList');
  const friendsCount = $('friendsCount');
  const friendInput = $('friendInput');
  let selectedFriend = null;

  function friendRow(p) {
    const row = document.createElement('div');
    row.className = 'friend' + (p.approved ? '' : ' pending');
    row.dataset.id = p.id;
    row.innerHTML = `
      <div class="friend-top">
        <span class="friend-name">${p.name || p.ip}</span>
        <span class="friend-state ${p.approved ? (p.page === false ? 'away' : 'ok') : 'wait'}">${p.approved ? (p.page === false ? '未开页面' : '在线') : '待确认'}</span>
      </div>
      <div class="friend-actions">
        ${p.approved
          ? '<button data-do="say">说一句</button><button data-do="reject">断开</button>'
          : '<button data-do="approve">同意</button><button data-do="reject">忽略</button>'}
      </div>
    `;
    row.querySelectorAll('button').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const doWhat = b.dataset.do;
      if (doWhat === 'say') {
        selectedFriend = p.id;
        friendInput?.focus();
        say(`对 ${p.name || p.ip} 说一句吧`, 1600);
        return;
      }
      await fetch(`${API_BASE}/peers/${doWhat}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id })
      });
      refreshFriends();
    }));
    return row;
  }

  async function refreshFriends() {
    if (!friendsList) return;
    try {
      const r = await fetch(API_BASE + '/peers');
      const d = await r.json();
      const peers = d.peers || [];
      if (friendsCount) friendsCount.textContent = String(peers.length);
      friendsList.innerHTML = '';
      if (!peers.length) {
        const e = document.createElement('div');
        e.className = 'friends-empty';
        e.textContent = '附近还没有别的书房';
        friendsList.appendChild(e);
        return;
      }
      peers.forEach(p => friendsList.appendChild(friendRow(p)));
    } catch (_) { /* 离线时不动 */ }
  }

  $('friendSend')?.addEventListener('click', async () => {
    const text = (friendInput?.value || '').trim();
    if (!text) return;
    if (!selectedFriend) { say('先点一个朋友，再说', 1600); return; }
    try {
      const r = await fetch(API_BASE + '/peers/say', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedFriend, text })
      });
      const d = await r.json();
      say(d.ok ? '发出去了' : '对方没接住…', 1600);
      if (d.ok) friendInput.value = '';
    } catch (_) { say('发送失败', 1600); }
  });

  window.roomPeers = {
    async list() {
      const r = await fetch(API_BASE + '/peers');
      return r.json();
    },
    async approve(id) {
      const r = await fetch(API_BASE + '/peers/approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      return r.json();
    },
    async reject(id) {
      const r = await fetch(API_BASE + '/peers/reject', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      return r.json();
    },
    async pairInfo() {
      const r = await fetch(API_BASE + '/pair/info');
      return r.json();
    },
    async pairSetCode(code) {
      const r = await fetch(API_BASE + '/pair/code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
      return r.json();
    },
    async pairSetMode(publicMode) {
      const r = await fetch(API_BASE + '/pair/mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ publicMode }) });
      return r.json();
    },
    async netAdvice() {
      const r = await fetch(API_BASE + '/net/advice');
      return r.json();
    },
    async invite() {
      const r = await fetch(API_BASE + '/punch/invite');
      return r.json();
    },
    async connect(invite) {
      const r = await fetch(API_BASE + '/punch/connect', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ invite }) });
      return r.json();
    },
    async punchStatus() {
      const r = await fetch(API_BASE + '/punch/status');
      return r.json();
    },
    async punchSay(text) {
      const r = await fetch(API_BASE + '/punch/say', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
      return r.json();
    },
    async add(host, port) {
      const r = await fetch(API_BASE + '/peers/add', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ host, port }) });
      return r.json();
    },
    async remove(host, port) {
      const r = await fetch(API_BASE + '/peers/remove', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ host, port }) });
      return r.json();
    },
    async say(id, text) {
      const r = await fetch(API_BASE + '/peers/say', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, text }) });
      return r.json();
    }
  };


  $('friendAdd')?.addEventListener('click', async () => {
    const raw = ($('friendAddr')?.value || '').trim();
    if (!raw) return;
    const [host, portStr] = raw.includes(':') ? raw.split(':') : [raw, '8796'];
    const port = parseInt(portStr, 10) || 8796;
    try {
      const r = await fetch(API_BASE + '/peers/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port })
      });
      const d = await r.json();
      if (d.ok) { say(`已添加 ${d.peer?.name || host}`, 1800); if ($('friendAddr')) $('friendAddr').value = ''; }
      else { say(d.error === 'unreachable' ? '连不上那个地址' : '添加失败', 2000); }
      refreshFriends();
    } catch (_) { say('添加失败', 1800); }
  });


  // ── 公网直连（STUN + 打洞）────────────────────────
  async function punchRefresh() {
    try {
      const r = await fetch(API_BASE + '/punch/status');
      const d = await r.json();
      const el = $('punchState');
      if (el) {
        el.textContent = d.connected ? ('已连接 ' + (d.peer || '')) : '未连接';
        el.classList.toggle('ok', !!d.connected);
      }
    } catch (_) {}
  }


  function showPunchAdvice(adv) {
    const box = $('punchAdvice');
    if (!box) return;
    if (!adv) { box.classList.add('hidden'); return; }
    $('punchAdviceTitle').textContent = adv.title || '打洞失败';
    const ol = $('punchAdviceSteps');
    ol.innerHTML = '';
    (adv.steps || []).forEach(t => {
      const li = document.createElement('li');
      li.textContent = t;
      ol.appendChild(li);
    });
    const btn = $('punchCopyTs');
    if (btn) {
      if (adv.tailscaleIp) {
        btn.classList.remove('hidden');
        btn.textContent = '复制我的 Tailscale 地址（' + adv.tailscaleIp + '）';
        btn.onclick = async () => {
          try { await navigator.clipboard.writeText(adv.tailscaleIp + ':8796'); say('已复制地址:端口', 1800); }
          catch (_) { say('复制失败，手动选中吧', 1800); }
        };
      } else {
        btn.classList.add('hidden');
      }
    }
    box.classList.remove('hidden');
  }

  $('punchInvite')?.addEventListener('click', async () => {
    try {
      const r = await fetch(API_BASE + '/punch/invite');
      const d = await r.json();
      if (d.ok) { $('punchCode').value = d.invite; say('邀请码好了，发给朋友', 2200); }
      else { say(d.error === 'stun-failed' ? 'STUN 连不上' : '生成失败', 2200); }
    } catch (_) { say('生成失败', 2000); }
  });

  $('punchCopy')?.addEventListener('click', async () => {
    const v = $('punchCode')?.value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); say('已复制', 1400); } catch (_) { $('punchCode')?.select(); }
  });

  $('punchConnect')?.addEventListener('click', async () => {
    const inv = ($('punchPeer')?.value || '').trim();
    if (!inv) return;
    say('正在打洞，最多等 25 秒…', 3000);
    try {
      const r = await fetch(API_BASE + '/punch/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invite: inv })
      });
      const d = await r.json();
      if (d.ok) { say('通了！', 2200); showPunchAdvice(null); }
      else { say(d.error === 'timeout' ? '打洞超时，看看下面的办法' : '连接失败', 2600); showPunchAdvice(d.advice || null); }
      punchRefresh();
    } catch (_) { say('连接失败', 2000); }
  });

  async function loadNetAdvice() {
    try {
      const r = await fetch(API_BASE + '/net/advice');
      const d = await r.json();
      const box = $('netBanner');
      if (!box) return;
      $('netTitle').textContent = d.title || '';
      $('netDetail').textContent = d.detail || '';
      const copyBtn = $('netCopy');
      const toggle = $('netToggle');
      if (d.address) {
        copyBtn.classList.remove('hidden');
        copyBtn.textContent = '复制 ' + d.address;
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(d.address); say('已复制 ' + d.address, 1800); }
          catch (_) { say('复制失败，手动选中吧', 1800); }
        };
        toggle.classList.remove('hidden');
        toggle.onclick = () => {
          const block = $('punchBody');
          if (block) {
            const hidden = block.classList.toggle('hidden');
            toggle.textContent = hidden ? '仍然尝试打洞' : '收起打洞';
          }
        };
      } else {
        copyBtn.classList.add('hidden');
        toggle.classList.add('hidden');
      }
      box.classList.remove('hidden');
    } catch (_) {}
  }


  // ── 配对码（可视化）────────────────────────────
  async function pairRefresh() {
    try {
      const r = await fetch(API_BASE + '/pair/info');
      const d = await r.json();
      if ($('pairCode')) $('pairCode').value = d.code || '';
      if ($('pairMode')) $('pairMode').textContent = d.publicMode ? '公网模式（需 16 位）' : '局域网';
    } catch (_) {}
  }

  $('pairCopy')?.addEventListener('click', async () => {
    const v = $('pairCode')?.value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); say('配对码已复制', 1600); }
    catch (_) { $('pairCode')?.select(); }
  });

  $('pairRotate')?.addEventListener('click', async () => {
    const info = await (await fetch(API_BASE + '/pair/info')).json();
    const need = info.publicMode ? 16 : 6;
    const chars = '0123456789abcdef';
    let code = '';
    for (let i = 0; i < need; i++) code += chars[Math.floor(Math.random() * chars.length)];
    await applyPair(code);
  });

  $('pairSet')?.addEventListener('click', () => {
    $('pairSetRow')?.classList.toggle('hidden');
    $('pairInput')?.focus();
  });

  async function applyPair(code) {
    const r = await fetch(API_BASE + '/pair/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const d = await r.json();
    if (d.ok) { say('配对码已更新，朋友那边也要填同一个', 2600); pairRefresh(); refreshFriends(); }
    else { say(d.error === 'too-short' ? ('至少要 ' + d.need + ' 位') : '更新失败', 2200); }
  }

  $('pairApply')?.addEventListener('click', async () => {
    const v = ($('pairInput')?.value || '').trim();
    if (v) await applyPair(v);
  });

  pairRefresh();

  loadNetAdvice();
  punchRefresh();
  setInterval(punchRefresh, 5000);


  // ── 页面在线状态（心跳 + 关页通知）──────────────
  function presenceBeat(alive) {
    try {
      const body = JSON.stringify({ alive });
      if (!alive && navigator.sendBeacon) {
        navigator.sendBeacon(API_BASE + '/presence', new Blob([body], { type: 'application/json' }));
      } else {
        fetch(API_BASE + '/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
    } catch (_) {}
  }

  presenceBeat(true);
  setInterval(() => presenceBeat(true), 8000);
  window.addEventListener('pagehide', () => presenceBeat(false));
  window.addEventListener('beforeunload', () => presenceBeat(false));

  refreshFriends();
  setInterval(refreshFriends, 3000);


  // 启动
  setMood(mood);
  setState('idle');
  scheduleBlink();
  scheduleIdleTalk();
})();
