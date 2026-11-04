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
    /** 容器探针是否通过；阶段 B 必须等它为 true 才敢往下装 QQ */
    static volatile boolean containerReady = false;
    /** 二维码文件（guest 里的 napcat/cache/qrcode.png 拷出来的副本） */
    private static volatile java.io.File qrPng = null;
    private static volatile java.io.File qrTxt = null;

    private Process proc;

    private static final Object BOOT_LOCK = new Object();
    private static boolean booted = false;

    public static String stage() { return stage; }
    public static String failReason() { return failReason; }
    public static boolean nodeRunning() { return nodeRunning; }

    /** 最近 n 行日志（旧 → 新） */
    /** 记录失败原因并上屏（阶段 B 与容器共用） */
    static void fail(String why) {
        failReason = why;
        push("[错误] " + why);
        setStage("失败：" + why);
    }

    /** 二维码就绪：MainActivity 轮询这两个文件 */
    static void setQr(java.io.File png, java.io.File txt) {
        qrPng = png;
        qrTxt = txt;
    }

    static java.io.File qrPng() {
        return qrPng;
    }

    static java.io.File qrTxt() {
        return qrTxt;
    }

    /**
     * 跑一段 guest 命令，**边跑边把输出推上屏**（apt 要跑几分钟，不能等结束才显示）。
     * 与 runProot 的区别：可指定超时、不截断到 40 行、实时 push。
     */
    static String[] proot(java.io.File base, String bashCmd, long timeoutMs) throws java.io.IOException {
        java.io.File proot = new java.io.File(base, "proot");
        java.util.List<String> cmd = new java.util.ArrayList<String>();
        cmd.add(new java.io.File(proot, "bin/proot").getAbsolutePath());
        cmd.add("--link2symlink");
        cmd.add("-0");
        cmd.add("-r");
        cmd.add(new java.io.File(base, "rootfs").getAbsolutePath());
        for (String m : new String[]{"/dev", "/proc", "/sys"}) {
            cmd.add("-b");
            cmd.add(m);
        }
        cmd.add("-b");
        cmd.add(new java.io.File(base, "shm").getAbsolutePath() + ":/dev/shm");
        cmd.add("-b");
        cmd.add(new java.io.File(base, "tmp").getAbsolutePath() + ":/tmp");
        cmd.add("-w");
        cmd.add("/root");
        cmd.add("/usr/bin/env");
        cmd.add("-i");
        cmd.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        cmd.add("HOME=/root");
        cmd.add("/bin/bash");
        cmd.add("-c");
        cmd.add(bashCmd);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        pb.directory(base);
        pb.environment().put("PROOT_TMP_DIR", new java.io.File(base, "tmp").getAbsolutePath());
        pb.environment().put("PROOT_NO_SECCOMP", "1");
        pb.environment().put("PROOT_LOADER", new java.io.File(proot, "libexec/proot/loader").getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", new java.io.File(proot, "lib").getAbsolutePath());

        final Process p = pb.start();
        final boolean[] timedOut = { false };
        final java.util.Timer watchdog = new java.util.Timer(true);
        watchdog.schedule(new java.util.TimerTask() {
            @Override
            public void run() {
                timedOut[0] = true;
                try { p.destroy(); } catch (Throwable ignored) { }
            }
        }, Math.max(30000, timeoutMs));

        // 只保留**最后** 400 行：pip/apt 的输出来到几千行，
        // 只留开头会把 PIP_FAIL / ALL_DONE 这种结尾标记丢掉；而且这里绝不能提前 break
        // —— 读端一停，子进程写满管道就卡死，最后会被看门狗当成超时杀掉。
        java.util.List<String> lines = new java.util.ArrayList<String>();
        BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream()));
        try {
            String line;
            while ((line = br.readLine()) != null) {
                lines.add(line);
                if (lines.size() > 400) lines.remove(0);
                push("[B] " + line);
            }
        } catch (java.io.IOException e) {
            if (!timedOut[0]) throw e;
        }
        try { p.waitFor(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        watchdog.cancel();
        if (timedOut[0]) lines.add("超时 " + (timeoutMs / 1000) + "s，已终止");
        return lines.toArray(new String[0]);
    }

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

    static void setStage(String s) {
        stage = s;
        push("[阶段] " + s);
    }

    static void push(String line) {
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
            // 先把桥接拉起来：容器准备再慢（甚至卡住）也不该拖住控制台。
            startNodeAsync(base);
            // 阶段 A（容器）：proot + rootfs。失败/超时只记原因，不影响桥接本体。
            setupContainer(base);
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

    /** node 单独一个线程跑：读它的 stdout 直到退出，不阻塞容器那一路 */
    private void startNodeAsync(final File base) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
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
                    failReason = "node 启动失败：" + t.getMessage();
                    push("[错误] " + failReason);
                    Log.e(TAG, "node failed", t);
                    setStage("失败");
                }
            }
        }, "qb-node").start();
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

    /**
     * 阶段 A：容器 = proot + Ubuntu rootfs。
     *
     * 关键参数（少一个就起不来，都是模拟器上踩出来的）：
     *  · PROOT_LOADER 指向 proot/libexec/proot/loader —— 缺它 guest 里一切报 execve ENOENT
     *  · LD_LIBRARY_PATH 指向 proot/lib —— libtalloc / libandroid-shmem 系统里没有
     *  · -b <base>/shm:/dev/shm —— Android 没有 /dev/shm，Electron 会 FATAL
     *  · /usr/bin/env -i PATH=... —— 不隔离 PATH，Android 的 PATH 会漏进 guest
     */
    private void setupContainer(File base) {
        try {
            File proot = new File(base, "proot");
            File rootfs = new File(base, "rootfs");
            File stamp = new File(base, ".container-ok");
            if (!stamp.exists()) {
                setStage("解压容器组件（首次约 60 秒）…");
                File tar = new File(base, "proot.tar");
                copyAsset("proot.tar", tar);
                untar(tar, base);
                tar.delete();
                chmod(new File(proot, "bin/proot"));
                chmod(new File(proot, "libexec/proot/loader"));
                push("proot 已就位");

                setStage("解压 Ubuntu rootfs（28MB，约 60 秒）…");
                File gz = new File(getCacheDir(), "rootfs.tar.gz");
                if (!gz.exists() || gz.length() == 0) copyAsset("ubuntu-base-arm64.tar.gz", gz);
                mkdirs(rootfs);
                untarGz(gz, rootfs);
                push("rootfs 解压完成");

                writeText(new File(rootfs, "etc/resolv.conf"),
                        "nameserver 223.5.5.5\nnameserver 119.29.29.29\n");
                File shm = new File(base, "shm");
                mkdirs(shm);
                chmodMode(shm, "1777");
                mkdirs(new File(base, "tmp"));
                if (!new File(rootfs, "bin/bash").exists()) throw new IOException("rootfs 里没有 bin/bash");
                stamp.createNewFile();
            } else {
                push("容器已就位，跳过解压");
            }

            setStage("容器探针…");
            String[] out = runProot(base, "echo CONTAINER_OK; uname -m; head -2 /etc/os-release");
            boolean ok = false;
            for (String l : out) {
                push("[容器] " + l);
                if (l.contains("CONTAINER_OK")) ok = true;
            }
            if (ok) {
                containerReady = true;
                setStage("容器可用（CONTAINER_OK）");
                // 阶段 B：QQ/NapCat。容器不可用时绝不走到这里
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        new StageB(BridgeService.this, base).run();
                    }
                }).start();
            } else {
                failReason = "容器探针没有输出 CONTAINER_OK";
                push("[错误] " + failReason);
            }
        } catch (Throwable t) {
            // 容器失败不阻断桥接：桥接本身还能跑，只是没有 QQ 通道
            failReason = "容器失败：" + t.getMessage();
            push("[错误] " + failReason);
            Log.e(TAG, "container failed", t);
        }
    }

    /** 在 guest 里跑一段 bash，返回前 40 行输出 */
    private String[] runProot(File base, String bashCmd) throws IOException {
        File proot = new File(base, "proot");
        java.util.List<String> cmd = new java.util.ArrayList<String>();
        cmd.add(new File(proot, "bin/proot").getAbsolutePath());
        cmd.add("--link2symlink");
        cmd.add("-0");
        cmd.add("-r");
        cmd.add(new File(base, "rootfs").getAbsolutePath());
        cmd.add("-b");
        cmd.add("/dev");
        cmd.add("-b");
        cmd.add("/proc");
        cmd.add("-b");
        cmd.add("/sys");
        cmd.add("-b");
        cmd.add(new File(base, "shm").getAbsolutePath() + ":/dev/shm");
        cmd.add("-b");
        cmd.add(new File(base, "tmp").getAbsolutePath() + ":/tmp");
        cmd.add("-w");
        cmd.add("/root");
        cmd.add("/usr/bin/env");
        cmd.add("-i");
        cmd.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        cmd.add("HOME=/root");
        cmd.add("/bin/bash");
        cmd.add("-c");
        cmd.add(bashCmd);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        pb.directory(base);
        pb.environment().put("PROOT_TMP_DIR", new File(base, "tmp").getAbsolutePath());
        pb.environment().put("PROOT_NO_SECCOMP", "1");
        pb.environment().put("PROOT_LOADER", new File(proot, "libexec/proot/loader").getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", new File(proot, "lib").getAbsolutePath());

        final Process p = pb.start();
        // 看门狗：90 秒强制结束。必须在下 readLine 之前装 —— readLine 是阻塞的，
        // 光在末尾 waitFor(90s) 没用（模拟器上 arm64 proot exec 不了，输出为空，会永久挂住）。
        final boolean[] timedOut = { false };
        final java.util.Timer watchdog = new java.util.Timer(true);
        watchdog.schedule(new java.util.TimerTask() {
            @Override
            public void run() {
                timedOut[0] = true;
                try { p.destroy(); } catch (Throwable ignored) { }
            }
        }, 90000);

        java.util.List<String> lines = new java.util.ArrayList<String>();
        BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream()));
        try {
            String line;
            while ((line = br.readLine()) != null) {
                lines.add(line);
                if (lines.size() >= 40) break;
            }
        } catch (IOException e) {
            // destroy() 会打断 readLine，这是看门狗的正常表现，不当错误往上抛
            if (!timedOut[0]) throw e;
        }
        try { p.waitFor(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        watchdog.cancel();
        if (timedOut[0]) {
            lines.add("探针 90 秒无输出，已终止（若本机是 x86 模拟器，arm64 的 proot 本来跑不了，这是预期）");
        }
        return lines.toArray(new String[0]);
    }

    private void untarGz(File gz, File dir) throws IOException {
        mkdirs(dir);
        // toybox tar 支持 -z；万一没有就走 gzip 管道
        String cmd = "cd '" + dir.getAbsolutePath() + "' && /system/bin/tar xzf '" + gz.getAbsolutePath() + "'";
        Process p = new ProcessBuilder("/system/bin/sh", "-c", cmd).redirectErrorStream(true).start();
        String out = readAll(p.getInputStream());
        int code;
        try {
            code = p.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("解压被中断");
        }
        if (code != 0) throw new IOException("解压 rootfs 失败 code=" + code + "：" + out.trim());
    }

    private static void mkdirs(File d) throws IOException {
        if (!d.exists() && !d.mkdirs()) throw new IOException("建目录失败：" + d);
    }

    private static void writeText(File f, String text) throws IOException {
        f.getParentFile().mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        out.write(text.getBytes("UTF-8"));
        out.close();
    }

    private void chmodMode(File f, String mode) {
        try {
            Runtime.getRuntime().exec(new String[]{"/system/bin/chmod", mode, f.getAbsolutePath()}).waitFor();
        } catch (Throwable ignored) { }
    }

    private void copyAsset(String name, File dst) throws IOException {        if (dst.exists() && dst.length() > 0) return;
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
