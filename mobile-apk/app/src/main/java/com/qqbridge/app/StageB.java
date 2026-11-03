package com.qqbridge.app;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 阶段 B：把 QQ + NapCat 弄进容器，直到能扫码。
 *
 * 设计取舍：
 *  · 178 MB 的 QQ deb 不塞 APK（APK 已经 105 MB），首次运行下载，进度上屏
 *  · 所有 guest 步骤串成一个 bash 脚本跑，每一步都 echo 标记，屏幕上看得到进行到哪
 *  · 容器没通过（没看到 CONTAINER_OK）就**停在这里并明确报错**，不假装往下装 QQ
 *  · 二维码：guest 里的 /root/napcat/cache/qrcode.png 拷到 files/qr.png，
 *    同时把解码 URL 写进 files/qr.txt —— 手机没有 adb，只能靠屏幕
 */
final class StageB {

    static final String QQ_URL = "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_arm64.deb";
    static final String NAPCAT_URL = "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip";
    static final String ONE_BOT_TOKEN = "qb-token-2026";

    private final Context ctx;
    private final File base;

    StageB(Context ctx, File base) {
        this.ctx = ctx;
        this.base = base;
    }

    /** 入口：容器可用才会被调用 */
    void run() {
        try {
            File qq = new File(getTmp(), "QQ.deb");
            File nc = new File(getTmp(), "NapCat.Shell.zip");
            BridgeService.push("[B] 准备 QQ 与 NapCat（首次约 5~10 分钟）");
            download(QQ_URL, qq, "QQ 客户端");
            download(NAPCAT_URL, nc, "NapCat");
            BridgeService.push("[B] 下载完成：QQ " + mb(qq) + " MB，NapCat " + mb(nc) + " MB");

            // launcher.cpp 与 onebot 配置随包带（手机上别联网拉源码）
            copyAsset("launcher.cpp", new File(getTmp(), "launcher.cpp"));
            copyAsset("onebot11.json", new File(getTmp(), "onebot11.json"));

            BridgeService.setStage("安装 QQ（apt，首次 3~8 分钟）…");
            String install = String.join("\n",
                    "set -e",
                    "echo '[1/4] apt update'",
                    "export DEBIAN_FRONTEND=noninteractive",
                    "apt-get update -qq",
                    "echo '[2/4] 装依赖'",
                    "apt-get install -y -qq ca-certificates curl xvfb screen xauth procps g++ zip unzip "
                            + "libasound2t64 libnss3 libgbm1 libgssapi-krb5-2 libxkbcommon0 "
                            + "libxdamage1 libxfixes3 libxrandr2 libatk1.0-0t64 libatk-bridge2.0-0t64 "
                            + "libcups2t64 libdrm2 libxcomposite1 libxshmfence1",
                    "echo '[3/4] 安装 QQ 本体'",
                    "apt-get install -y -qq /tmp/QQ.deb",
                    "echo '[4/4] 布置 NapCat'",
                    "mkdir -p /root/napcat",
                    "unzip -q -o -d /root/napcat /tmp/NapCat.Shell.zip",
                    "cp /tmp/launcher.cpp /root/launcher.cpp",
                    "cd /root && g++ -shared -fPIC launcher.cpp -o libnapcat_launcher.so -ldl",
                    "mkdir -p /root/napcat/config",
                    "cp /tmp/onebot11.json /root/napcat/config/onebot11.json",
                    "echo 'INSTALL_DONE'");
            boolean ok = runSh(install, 900000);
            if (!ok) {
                BridgeService.fail("QQ 安装阶段失败（看上面最后一行输出）");
                return;
            }

            writeBridgeConfig();
            BridgeService.setStage("启动 QQ（第一次会初始化，稍等）…");
            startQq();
            pollQr();
        } catch (Throwable t) {
            Log.e("qqb", "stageB failed", t);
            BridgeService.fail("阶段 B 异常：" + t.getMessage());
        }
    }

    private File getTmp() {
        File t = new File(base, "tmp");
        if (!t.exists()) t.mkdirs();
        return t;
    }

    private static String mb(File f) {
        return String.valueOf(Math.round(f.length() / 1024 / 1024));
    }

    /** 首次运行写一份手机默认配置：网关 napcat、本地大脑 */
    private void writeBridgeConfig() throws IOException {
        File cfg = new File(base, "app/config.json");
        if (cfg.exists()) {
            BridgeService.push("[B] 已有 config.json，不覆盖");
            return;
        }
        String json = "{\n"
                + "  \"consolePort\": 3100,\n"
                + "  \"consoleHost\": \"127.0.0.1\",\n"
                + "  \"gateway\": { \"provider\": \"napcat\", \"wsUrl\": \"ws://127.0.0.1:6199\",\n"
                + "                 \"httpUrl\": \"http://127.0.0.1:6198\", \"token\": \"" + ONE_BOT_TOKEN + "\" },\n"
                + "  \"agent\": { \"enabled\": true, \"mode\": \"local\", \"maxSteps\": 4 },\n"
                + "  \"allowAllWhenEmpty\": false,\n"
                + "  \"fileIndex\": { \"enabled\": false }\n"
                + "}\n";
        FileOutputStream out = new FileOutputStream(cfg);
        out.write(json.getBytes("UTF-8"));
        out.close();
        BridgeService.push("[B] 已写默认 config.json（gateway=napcat，agent=local）");
    }

    /** 起 QQ：xvfb 提供虚拟显示，LD_PRELOAD 把 NapCat 注进去 */
    private void startQq() throws IOException {
        String cmd = "cd /root && setsid xvfb-run -a env LD_PRELOAD=/root/libnapcat_launcher.so "
                + "/opt/QQ/qq --no-sandbox > /root/qq.log 2>&1 < /dev/null & echo QQ_STARTED";
        String[] out = BridgeService.proot(base, cmd, 120000);
        for (String l : out) BridgeService.push("[B] " + l);
    }

    /** 轮询二维码：guest 的 png 拷出来，URL 记到 qr.txt */
    private void pollQr() {
        File qr = new File(base, "qr.png");
        File txt = new File(base, "qr.txt");
        int same = 0;
        for (int i = 0; i < 180; i++) {   // 最多 15 分钟
            try {
                // 让 guest 把最新二维码与 URL 送出来
                BridgeService.proot(base, "cp -f /root/napcat/cache/qrcode.png /tmp/qr.png 2>/dev/null; "
                        + "grep -a -o 'https://txz.qq.com[^ ]*' /root/qq.log 2>/dev/null | tail -1 > /tmp/qr.txt; echo SYNC",
                        60000);
                File inGuest = new File(base, "tmp/qr.png");
                if (inGuest.exists() && inGuest.length() > 0) {
                    copyFile(inGuest, qr);
                    File urlGuest = new File(base, "tmp/qr.txt");
                    if (urlGuest.exists()) copyFile(urlGuest, txt);
                    BridgeService.setStage("等待扫码（二维码已就绪）");
                    BridgeService.setQr(qr, txt);
                    same = 0;
                } else {
                    same++;
                }
                if (same > 3) BridgeService.setStage("QQ 启动了，但还没生成二维码（看日志）");
            } catch (Throwable t) {
                BridgeService.push("[B] 取二维码失败：" + t.getMessage());
            }
            try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        }
    }

    // ── 下面是裸工具：下载、跑 guest 脚本、复制文件 ──

    private void download(String urlStr, File dst, String label) throws IOException {
        if (dst.exists() && dst.length() > 1024 * 1024) {
            BridgeService.push("[B] " + label + " 已存在，跳过下载");
            return;
        }
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "qqbridge-apk");
        int code = c.getResponseCode();
        if (code != 200) throw new IOException(label + " 下载失败 HTTP " + code);
        long total = c.getContentLengthLong();
        InputStream in = c.getInputStream();
        FileOutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[1 << 16];
        long got = 0;
        int n;
        int lastPct = -1;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            got += n;
            if (total > 0) {
                int pct = (int) (got * 100 / total);
                if (pct != lastPct && pct % 5 == 0) {
                    lastPct = pct;
                    BridgeService.setStage("下载 " + label + " " + pct + "%");
                }
            }
        }
        out.close();
        in.close();
        c.disconnect();
        BridgeService.push("[B] " + label + " 下载完成 " + mb(dst) + " MB");
    }

    private boolean runSh(String script, long timeoutMs) throws IOException {
        String[] out = BridgeService.proot(base, script, timeoutMs);
        boolean done = false;
        for (String l : out) {
            BridgeService.push("[B] " + l);
            if (l.contains("INSTALL_DONE")) done = true;
        }
        return done;
    }

    private void copyAsset(String name, File dst) throws IOException {
        if (dst.exists() && dst.length() > 0) return;
        InputStream in = ctx.getAssets().open(name);
        FileOutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.close();
        in.close();
    }

    private static void copyFile(File src, File dst) throws IOException {
        InputStream in = new java.io.FileInputStream(src);
        OutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.close();
        in.close();
    }
}
