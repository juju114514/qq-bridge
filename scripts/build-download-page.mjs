// 生成「下载页」（0.4.118）
//
// 为什么单独做：普通用户打不开 GitHub、也不会用命令行。给他们一个**一页就能下完**的页面：
//   · 手机扫码/点按钮 → 下 APK
//   · 电脑端 → 下绿色包或源码
//
// 用法：
//   node scripts/build-download-page.mjs
//   node scripts/build-download-page.mjs --apk "C:\path\to\app.apk" --lanpan "https://wwxx.lanzou.com/xxxx"
//
// 产物：dist/download.html（单文件，可直接丢到任何静态托管 / 蓝奏云笔记 / OSS）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function findApk() {
  const explicit = arg('apk');
  if (explicit && fs.existsSync(explicit)) return explicit;
  // 常见位置：桌面（用户手动放的）/ 仓库根 / dist
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Desktop', 'QQ桥接-0.5.2.apk'),
    path.join(ROOT, 'dist', 'QQ桥接.apk'),
    path.join(ROOT, 'app-debug.apk')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // 桌面里任意 QQ桥接-*.apk
  const desk = path.join(process.env.USERPROFILE || '', 'Desktop');
  try {
    const hit = fs.readdirSync(desk).filter((f) => /^QQ桥接.*\.apk$/i.test(f)).sort().pop();
    if (hit) return path.join(desk, hit);
  } catch { /* 没有桌面就跳过 */ }
  return '';
}

function fileInfo(p) {
  if (!p || !fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return {
    name: path.basename(p),
    bytes: buf.length,
    mb: (buf.length / 1024 / 1024).toFixed(2),
    sha256: crypto.createHash('sha256').update(buf).digest('hex')
  };
}

const version = readVersion();
const apkPath = findApk();
const apk = fileInfo(apkPath);
const lanpanUrl = arg('lanpan', '');
const lanpanPass = arg('lanpan-pass', '');
const ghProxy = `https://ghproxy.com/https://github.com/juju114514/qq-bridge`;
const ghProxyZip = `${ghProxy}/archive/refs/heads/main.zip`;

const apkCard = apk
  ? `<div class="dl">
      <div class="dl-title">手机端 · Android</div>
      <div class="dl-meta">${apk.name} · ${apk.mb} MB</div>
      <div class="btns">
        ${lanpanUrl ? `<a class="btn primary" href="${lanpanUrl}" target="_blank" rel="noreferrer">下载 APK（蓝奏云）</a>` : ''}
        <a class="btn${lanpanUrl ? '' : ' primary'}" href="./downloads/${apk.name}">下载 APK（本站）</a>
      </div>
      ${lanpanUrl ? `<div class="note">蓝奏云页面里点<b>「普通下载」</b>（不要点客户端）；${lanpanPass ? `提取码 <code>${lanpanPass}</code>` : '无提取码'}</div>` : ''}
      <div class="hash">SHA256 ${apk.sha256.slice(0, 32)}…</div>
    </div>`
  : `<div class="dl"><div class="dl-title">手机端 · Android</div>
      <div class="dl-meta">APK 还没生成：跑 <code>node scripts/build-download-page.mjs --apk &lt;路径&gt;</code></div></div>`;

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 桥接 · 下载 v${version}</title>
<style>
:root{--bg:#101a2b;--card:#16233a;--line:#24344f;--text:#e6eeff;--dim:#9fb3d0;--blue:#4c8dff}
*{box-sizing:border-box;min-width:0}
html,body{overflow-x:hidden}
code,.hash,.dl-meta{word-break:break-word;overflow-wrap:anywhere}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#1a2b47,#0b1220 60%);color:var(--text);
     font:16px/1.7 "Microsoft YaHei",system-ui,-apple-system,sans-serif;padding:28px 18px 60px;
     max-width:100vw}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px}
.sub{color:var(--dim);font-size:14px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px}
.dl-title{font-size:18px;font-weight:600;margin-bottom:4px}
.dl-meta{color:var(--dim);font-size:13px;margin-bottom:12px;word-break:break-all}
.btns{display:flex;gap:10px;flex-wrap:wrap}
.btn{max-width:100%}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border-radius:12px;
     border:1px solid var(--line);background:#1d2d47;color:var(--text);text-decoration:none;font-size:15px}
.btn.primary{background:linear-gradient(180deg,#3f7ff0,#2f66cc);border-color:#3f7ff0}
.btn:active{transform:translateY(1px)}
.hash{color:#6b7f9c;font-size:11px;margin-top:10px;word-break:break-all}
.note{margin-top:10px;font-size:13px;color:#ffd9a8;background:rgba(240,160,63,.10);
      border:1px solid rgba(240,160,63,.35);border-radius:10px;padding:8px 10px}
h2{font-size:17px;margin:24px 0 10px}
ol,ul{margin:8px 0 0;padding-left:22px;color:var(--dim);font-size:14px}
li{margin:6px 0}
code{background:#0e1726;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
.warn{border-left:3px solid #f0a03f;padding-left:12px;color:#ffcf99;font-size:13px;margin-top:14px}
a{color:#8ec5ff}
</style></head>
<body><div class="wrap">
  <h1>QQ 桥接 · 控制台</h1>
  <div class="sub">把 DeepSeek Harness 接进 QQ：人格、记忆、工具都在你自己电脑上，手机随时看。版本 v${version}</div>

  ${apkCard}

  <div class="card">
    <div class="dl-title">电脑端 · 服务端</div>
    <div class="dl-meta">需要一台常开的 Windows 电脑（桥接跑在这里）</div>
    <div class="btns">
      <a class="btn" href="${ghProxyZip}" target="_blank" rel="noreferrer">源码 zip（加速镜像）</a>
      <a class="btn" href="https://github.com/juju114514/qq-bridge" target="_blank" rel="noreferrer">GitHub 仓库</a>
    </div>
    <div class="hash">加速镜像随时可能失效，两个都打不开时把 ghproxy.com 换成别家镜像即可</div>
  </div>

  <h2>手机端怎么装</h2>
  <ol>
    <li>下载上面的 APK，安装时允许「未知来源」</li>
    <li>电脑上启动桥接，打开控制台 →「调试与运维 → 手机设备 → 显示连接二维码」</li>
    <li>手机 App 点「扫一扫」，对着电脑屏幕扫一下</li>
    <li>连上后就是控制台；也可以直接加到主屏幕当 App 用</li>
  </ol>

  <h2>电脑端怎么跑</h2>
  <ol>
    <li>解压 zip，双击 <code>启动.cmd</code>（或按 <code>QUICKSTART.md</code> 走）</li>
    <li>控制台地址：<code>http://127.0.0.1:3100</code>，令牌在 <code>state/console-token</code></li>
    <li>要手机连？把 <code>consoleHost</code> 改成 <code>0.0.0.0</code>，手机连同一个 WiFi</li>
  </ol>

  <div class="warn">
    出门在外想用手机控制：装 Tailscale（电脑+手机同账号），地址填 <code>http://100.x.x.x:3100</code>。
    <b>不要</b>把控制台直接映射到公网——它能发消息、删说说、重置会话。
  </div>

  <h2>常见问题</h2>
  <ul>
    <li><b>手机提示连接被拒</b>：地址里可能是 <code>127.0.0.1</code>（那是手机自己），要用电脑的局域网 IP</li>
    <li><b>和电脑不在同一 WiFi</b>：局域网 IP 连不上，出门请用 Tailscale</li>
    <li><b>装不上 APK</b>：先卸载旧版（签名不同不能覆盖）</li>
  </ul>

  <div class="sub" style="margin-top:28px">© ${new Date().getFullYear()} qq-bridge · 数据与账号都在你自己机器上</div>
</div></body></html>
`;

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(path.join(outDir, 'downloads'), { recursive: true });
if (apkPath) {
  fs.copyFileSync(apkPath, path.join(outDir, 'downloads', path.basename(apkPath)));
}
fs.writeFileSync(path.join(outDir, 'download.html'), html, 'utf8');

console.log(`  ✓ dist/download.html  (v${version})`);
if (apk) {
  console.log(`  ✓ 已复制 APK: downloads/${apk.name}  ${apk.mb} MB`);
  console.log(`    SHA256 ${apk.sha256}`);
} else {
  console.log('  ⚠ 没找到 APK，页面里的「本站下载」会 404；用 --apk <路径> 指定');
}
if (!lanpanUrl) console.log('  ⚠ 没给蓝奏云链接（--lanpan <url>），页面上不会出现那个按钮');
else console.log(`  ✓ 蓝奏云按钮：${lanpanUrl}${lanpanPass ? '（提取码 ' + lanpanPass + '）' : ''}`);
