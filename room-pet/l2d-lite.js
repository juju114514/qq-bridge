// 伪 L2D：不切片、不绑骨骼，靠"整图 + 头部切片"两张同源图层做错觉。
//
// 原理：
//   1) body 层做呼吸（纵向轻微缩放）与整体倾摆
//   2) head 层是同一张图，但被 CSS mask 裁出头顶约 34%，跟随鼠标做横向位移 + 轻微旋转
//      羽化过的接缝让人看不出是两张图
//   3) 点击 → 挤压回弹（scaleY 压扁再弹起）
//   4) SSE 接 /events，思考/说话时气泡与轻微前倾

const body = document.getElementById('body');
const head = document.getElementById('head');
const stage = document.getElementById('stage');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubbleText');
const stateText = document.getElementById('stateText');

let mx = 0.5;          // 鼠标归一化 X
let my = 0.5;
let blink = 0;         // 呼吸相位
let squash = 0;        // 点击挤压量
let lean = 0;          // 说话前倾

// 鼠标 → 归一化坐标
window.addEventListener('mousemove', (e) => {
  mx = e.clientX / window.innerWidth;
  my = e.clientY / window.innerHeight;
});

window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  mx = t.clientX / window.innerWidth;
  my = t.clientY / window.innerHeight;
}, { passive: true });

// 点击挤压
function boop() {
  squash = 0.18;
  say('呀！', 900);
}
body.addEventListener('click', boop);
head.addEventListener('click', boop);

// 气泡
let bubbleTimer = null;
function say(text, ms = 2200) {
  if (!text) return;
  bubbleText.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
}

// 主循环：所有位移都在这里算，避免多处写 transform 打架
function tick(now) {
  const t = now / 1000;
  blink = t;

  // 呼吸：3.6 秒一个周期，纵向 0.6%~1.2%
  const breath = Math.sin(t * (Math.PI * 2 / 3.6));
  const bodyScaleY = 1 + breath * 0.006;
  const bodyScaleX = 1 - breath * 0.0035;

  // 挤压回弹
  squash *= 0.90;
  const sq = squash * Math.sin(t * 40) * 0.5 + squash;

  // 身体整体：轻微左右摆（幅度 3px）
  const sway = Math.sin(t * 0.9) * 3;

  body.style.transform =
    `translateX(calc(-50% + ${sway}px)) scale(${bodyScaleX}, ${bodyScaleY - sq})`;

  // 头部：跟随鼠标横向（±14px）+ 旋转（±3.2 度），并带 0.12 秒滞后
  const targetX = (mx - 0.5) * 28;
  const targetR = (mx - 0.5) * 6.4;
  const targetY = (my - 0.5) * 6;

  headX += (targetX - headX) * 0.12;
  headR += (targetR - headR) * 0.12;
  headY += (targetY - headY) * 0.12;

  const bob = Math.sin(t * 0.9) * 1.5;      // 头部随呼吸轻微上下
  head.style.transform =
    `translateX(calc(-50% + ${headX + sway}px)) translateY(${headY + bob}px) rotate(${headR}deg) scale(${1 + lean * 0.005}, ${bodyScaleY - sq})`;

  // 阴影跟着呼吸变淡
  const shadow = document.getElementById('shadow');
  if (shadow) {
    shadow.style.opacity = String(0.55 + breath * 0.05);
    shadow.style.transform = `translateX(calc(-50% + ${sway * 0.6}px)) scaleX(${1 + breath * 0.01})`;
  }

  requestAnimationFrame(tick);
}

let headX = 0, headR = 0, headY = 0;
requestAnimationFrame(tick);

// ── 状态联动（和 index.html 同一套 SSE）──
function setState(st) {
  stateText.textContent = st;
  document.title = '深夜书房 · ' + st;
  if (st === 'thinking') { lean = 1; say('……让我想想。', 2200); }
  else if (st === 'speaking') { lean = 1.6; }
  else { lean = 0; }
}

function connectState() {
  if (!window.EventSource || location.protocol !== 'http:') return;
  const es = new EventSource('http://127.0.0.1:8796/events');
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    const st = d.state || 'idle';
    const text = (d.text || '').trim();
    if (st === 'speaking') { say(text || '……', 3200); setState('speaking'); }
    else if (st === 'thinking') { setState('thinking'); say(text || '……让我想想。', 2200); }
    else if (st === 'peer_say') {
      const [from, ...rest] = text.split('|');
      say(`${from} 说：${rest.join('|')}`, 3200);
      setState('listening');
    } else setState('idle');
  };
  es.onerror = () => { es.close(); setTimeout(connectState, 2000); };
}
connectState();

// 空闲时随机说一句
const lines = ['窗外好像在下雨。', '你今天回来得好晚。', '这本书我看到一半了。', '要不要一起发会儿呆？'];
setInterval(() => {
  if (Math.random() < 0.35) say(lines[Math.floor(Math.random() * lines.length)], 2600);
}, 45000);
