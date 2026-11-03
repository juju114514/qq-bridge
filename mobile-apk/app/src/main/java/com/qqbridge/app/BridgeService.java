package com.qqbridge.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayDeque;

/**
 * 前台服务：把 assets 铺到私有目录，然后 exec node 跑桥接。
 *
 * 为什么必须前台服务：Android 会杀掉后台普通进程；桥接要长期在线接消息。
 * 为什么 exec 能work：本 App 的 targetSdk = 28（见 docs/design/ANDROID-APK-PLAN.md）。
 *
 * 诊断（0.5.60）：把「当前阶段 / 失败原因 / 最近日志」放在静态字段里，
 * 让 Activity 每 500ms 拉一次显示 —— 界面上必须能看见卡在哪一步，
 * 之前是白屏 5 分钟，用户完全无从判断。
 */
public class BridgeService extends Service {

    private static final String TAG = "qqb";
    private static final String CH = "qqb";
    private static final int NOTI = 1;
    private static final int LOG_KEEP = 200;

    /** 界面直接读的三样东西 */
    private static final ArrayDeque<String> LOG = new ArrayDeque<String>();
    private static volatile String stage = "尚未启动";
    private static volatile String failReason = "";
    private static volatile boolean nodeRunning = false;

    private Process proc;

    private static final Object BOOT_LOCK = new Object();
    private static boolean booted = false;

    public static String stage() { return stage; }
    public static String failReason() { return failReason; }
    public static boolean nodeRunning() { return nodeRunning; }

    /** 最近 n 行日志（旧 → 新） */
    public static String[] tail(int n) {
        synchronized (LOG) {
            int size = LOG.size();
            int from = Math.max(0, size - n);
            String[] out = new String[size - from];
            int i = 0;
            for (String s : LOG) {
                if (i >= from) out[i - from] = s;
                i++;
            }
            return out;
        }
    }

    /** 给「复制日志」用：阶段 + 失败原因 + 全部日志 */
    public static String dump() {
        StringBuilder sb = new StringBuilder();
        sb.append("阶段: ").append(stage).append('\n');
        if (failReason != null && failReason.length() > 0) sb.append("失败原因: ").append(failReason).append('\n');
        sb.append("node 存活: ").append(nodeRunning ? "是" : "否").append('\n');
        sb.append("---- 日志 ----\n");
        String[] all = tail(LOG_KEEP);
        for (String s : all) sb.append(s).append('\n');
        return sb.toString();
    }

    private static void setStage(String s) {
        stage = s;
        push("[阶段] " + s);
    }

    private static void push(String line) {
        String t = line.length() > 400 ? line.substring(0, 400) : line;
        synchronized (LOG) {
            LOG.addLast(t);
            while (LOG.size() > LOG_KEEP) LOG.removeFirst();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        startForeground(NOTI, buildNoti("正在启动…"));
        new Thread(new Runnable() {
            @Override
            public void run() {
                boot();
            }
        }).start();
        return START_STICKY;
    }

    private void boot() {
        synchronized (BOOT_LOCK) {
            if (booted) {
                push("boot 已在运行，跳过重复启动");
                return;
            }
            booted = true;
        }
        try {
            File base = new File(getFilesDir(), "app");
            setStage("解压/校验资源（首次约 60 秒）…");
            stage(base);
            ensurePackageJson(base);
            File node = new File(getFilesDir(), "bin/node");
            chmod(node);
            File script = new File(base, "src/bridge.js");
            if (!script.exists()) throw new IOException("缺 src/bridge.js，assets 没铺好");

            setStage("启动 node…");
            ProcessBuilder pb = new ProcessBuilder(node.getAbsolutePath(), "src/bridge.js");
            pb.directory(base);
            pb.redirectErrorStream(true);
            pb.environment().put("LD_LIBRARY_PATH", new File(getFilesDir(), "lib").getAbsolutePath());
            pb.environment().put("HOME", base.getAbsolutePath());
            pb.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            pb.environment().put("NODE_ENV", "production");
            pb.environment().put("NODE_EXTRA_CA_CERTS", new File(getFilesDir(), "ca/cacert.pem").getAbsolutePath());

            proc = pb.start();
            nodeRunning = true;
            setStage("node 已启动，等控制台监听 3100…");
            BufferedReader br = new BufferedReader(new InputStreamReader(proc.getInputStream()));
            String line;
            while ((line = br.readLine()) != null) {
                Log.i(TAG, line);
                push(line);
                if (line.contains("控制台已启动")) {
                    setStage("桥接已就绪 · http://127.0.0.1:3100");
                    updateNoti("已运行 · 3100");
                }
            }
            nodeRunning = false;
            int code = proc.waitFor();
            failReason = "node 退出，code=" + code;
            setStage("node 已退出");
            updateNoti(failReason);
        } catch (Throwable t) {
            nodeRunning = false;
            String msg = String.valueOf(t.getMessage());
            // 分类：让界面上的一句话能指方向
            if (msg.contains("node_modules") || msg.contains("payload.tar")) {
                failReason = "解压失败：" + msg;
            } else if (msg.contains("tar 退出码")) {
                failReason = "解包失败（Android tar 不支持这种条目）：" + msg;
            } else if (msg.contains("package.json")) {
                failReason = "入口 package.json 不可用：" + msg;
            } else {
                failReason = "启动失败：" + msg;
            }
            push("[错误] " + failReason);
            Log.e(TAG, "boot failed", t);
            setStage("失败");
            updateNoti(failReason);
        }
    }

    private void ensurePackageJson(File base) throws IOException {
        File f = new File(base, "package.json");
        boolean ok = false;
        if (f.exists() && f.length() > 100) {
            byte[] head = new byte[(int) Math.min(4096, f.length())];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = in.read(head);
            in.close();
            String s = new String(head, 0, Math.max(n, 0), "UTF-8").trim();
            ok = s.startsWith("{") && s.contains("\"name\"");
        }
        if (!ok) {
            push("package.json 不可用（len=" + (f.exists() ? f.length() : -1) + "），从 assets 重铺");
            if (f.exists()) f.delete();
            copyAsset("package.json", f);
            if (!f.exists() || f.length() < 100) throw new IOException("package.json 重铺失败");
        }
    }

    /** 首次运行：把 assets 里的 node / app / 配置铺到私有目录（幂等） */
    private void stage(File base) throws IOException {
        push("铺 node / CA / 入口文件…");
        copyAsset("node", new File(getFilesDir(), "bin/node"));
        copyAsset("cacert.pem", new File(getFilesDir(), "ca/cacert.pem"));
        copyAsset("bridge.js", new File(base, "src/bridge.js"));
        copyAsset("package.json", new File(base, "package.json"));
        if (!new File(base, "config.json").exists()) {
            copyAsset("config.example.json", new File(base, "config.json"));
        }
        stageLibs();
        File stamp = new File(base, ".payload-ok");
        if (stamp.exists() && new File(base, "node_modules").exists()) {
            push("payload 已解过，跳过");
            return;
        }
        setStage("解压 payload（243MB，约 40~60 秒）…");
        File tar = new File(base, "payload.tar");
        copyAsset("payload.tar", tar);
        untar(tar, base);
        if (!new File(base, "node_modules").exists()) {
            throw new IOException("payload.tar 解包后仍缺 node_modules");
        }
        tar.delete();
        stamp.createNewFile();
        push("payload 解压完成");
    }

    /** node 的运行库：Termux 构建依赖 libz/libssl/libicu 等（Android 系统里没有） */
    private void stageLibs() throws IOException {
        File lib = new File(getFilesDir(), "lib");
        File stamp = new File(lib, ".ok");
        if (stamp.exists()) return;
        setStage("解压 node 运行库（45MB）…");
        File tar = new File(getFilesDir(), "libs.tar");
        copyAsset("libs.tar", tar);
        untar(tar, lib);
        if (!new File(lib, "libz.so.1").exists()) throw new IOException("libs.tar 解包后缺 libz.so.1");
        tar.delete();
        stamp.createNewFile();
    }

    private void copyAsset(String name, File dst) throws IOException {
        if (dst.exists() && dst.length() > 0) return;
        dst.getParentFile().mkdirs();
        InputStream in = getAssets().open(name);
        FileOutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.close();
        in.close();
    }

    /** 用系统 tar 解包（Android 6+ 都有），比手写 tar 解析稳 */
    private void untar(File tar, File dir) throws IOException {
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("建目录失败：" + dir);
        try {
            Process p = new ProcessBuilder("/system/bin/tar", "xf", tar.getAbsolutePath(), "-C", dir.getAbsolutePath())
                    .redirectErrorStream(true).start();
            String out = readAll(p.getInputStream());
            int code = p.waitFor();
            if (code != 0) throw new IOException("tar 退出码 " + code + "：" + out.trim());
        } catch (IOException e) {
            throw e;
        } catch (Throwable t) {
            throw new IOException("解包失败：" + t);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(in));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) {
            sb.append(line).append('\n');
            if (sb.length() > 2000) break;
        }
        return sb.toString();
    }

    private void chmod(File f) {
        try {
            Runtime.getRuntime().exec(new String[]{"/system/bin/chmod", "755", f.getAbsolutePath()}).waitFor();
        } catch (Throwable ignored) { }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CH) == null) {
            nm.createNotificationChannel(new NotificationChannel(CH, "桥接运行状态", NotificationManager.IMPORTANCE_LOW));
        }
    }

    private Notification buildNoti(String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CH)
                : new Notification.Builder(this);
        return b.setContentTitle("QQ 桥接").setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true).build();
    }

    private void updateNoti(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTI, buildNoti(text));
        } catch (Throwable ignored) { }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (proc != null) proc.destroy();
        nodeRunning = false;
        super.onDestroy();
    }
}
