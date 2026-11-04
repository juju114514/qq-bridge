package com.qqbridge.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.provider.MediaStore;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.zip.GZIPOutputStream;

/**
 * 把容器 rootfs 打成 tar.gz 丢到「下载/qq-bridge」，用户 USB 连电脑就能拷走。
 *
 * 三条硬规矩：
 *  1. **不碰主线程**：整件事跑在 "qb-export" 线程里，界面只读静态字段（state/bytes/phase）。
 *  2. **不在 Java 里递归打 tar**：rootfs + QQ + NapCat 有几十万个文件，递归打包又慢又容易被
 *     OOM / fd 耗尽搞死。优先交给系统的 toybox tar（`/system/bin/tar czf`）；
 *     它不支持 -z 时才退化成 `tar cf` + 流式 GZIPOutputStream（8KB 缓冲）。
 *  3. **不把大文件读进堆**：传输只有 8KB 的 byte[]，产物 1~2GB 也不会 OOM。
 *
 * 为什么不放 Service 里：BridgeService 是前台服务，进程活着这个线程就活着；导出结束即
 * 收工，没必要再挂一个服务组件（多一个组件的生命周期反而更容易出坑）。
 */
final class RootfsExporter {

    static final String DIR_NAME = "qq-bridge";
    static final int IDLE = 0;
    static final int RUN = 1;
    static final int OK = 2;
    static final int FAIL = 3;

    private static final Object LOCK = new Object();

    /** 界面直接读的东西（都 volatile，写端只有导出线程） */
    static volatile int state = IDLE;
    static volatile long bytes = 0L;
    static volatile String phase = "";
    static volatile String result = "";
    /** 每次结束 +1：界面靠它去重，避免同一条结果反复上屏 */
    static volatile int seq = 0;

    /** 最近一次成功的产物，给「分享镜像」用（content Uri，可直接 ACTION_SEND） */
    static volatile String shareUri = "";
    static volatile String shareName = "";
    static volatile long shareSize = 0L;

    /** 进度回读：当前正在写的文件（null = 由拷贝循环自己报进度） */
    private static volatile File watch = null;
    /** tar 是否支持 -z：-1 未探测 / 0 不支持 / 1 支持 */
    private static volatile int tarGzProbe = -1;

    private RootfsExporter() { }

    static boolean running() {
        return state == RUN;
    }

    /**
     * 容器根目录。BridgeService 里是 getFilesDir()/app/rootfs，历史版本/文档里写过
     * getFilesDir()/rootfs —— 两个都认，先看实际存在的那个。
     */
    static File rootfsDir(Context c) {
        File a = new File(c.getFilesDir(), "app/rootfs");
        if (a.isDirectory()) return a;
        File b = new File(c.getFilesDir(), "rootfs");
        if (b.isDirectory()) return b;
        return a;
    }

    /** 返回 false 表示已经有一个在跑了 */
    static boolean start(Context ctx, File rootfs) {
        synchronized (LOCK) {
            if (state == RUN) return false;
            state = RUN;
            bytes = 0L;
            phase = "准备";
            result = "";
            shareUri = "";
            shareName = "";
            watch = null;
        }
        final Context app = ctx.getApplicationContext();
        final File rf = rootfs;
        Thread t = new Thread(new Runnable() {
            @Override public void run() { work(app, rf); }
        }, "qb-export");
        t.setDaemon(true);
        t.start();
        startWatcher();
        return true;
    }

    // ───────────────────────── 主流程 ─────────────────────────

    private static void work(Context app, File rootfs) {
        File exportDir = new File(app.getFilesDir(), "export");
        File tmp = null;
        File tmpTar = null;
        try {
            if (!rootfs.isDirectory()) throw new ExportError("找不到容器目录：" + rootfs.getPath());
            if (!exportDir.exists() && !exportDir.mkdirs()) {
                throw new ExportError("建不了临时目录：" + exportDir.getPath());
            }

            log("开始导出 " + rootfs.getPath());
            long src = dirSize(rootfs);
            if (src <= 0) throw new ExportError("容器目录是空的：" + rootfs.getPath());
            // gz 一般能压到 4~6 成；留 8MB 余量给 tar 自己的临时开销
            final long est = Math.max(64L << 20, (long) (src * 0.62));
            log("源目录 " + human(src) + "，预计产物约 " + human(est));

            final long need = est + (8L << 20);
            final long in = avail(rootfs);
            if (in > 0 && in < need) {
                throw new ExportError("内部空间不足：需要约 " + human(need) + "，当前只剩 " + human(in));
            }
            final long out = availOut(app);
            if (out > 0 && out < need) {
                throw new ExportError("下载目录空间不足：需要约 " + human(need) + "，当前只剩 " + human(out));
            }

            String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
            final String name = "rootfs-" + stamp + ".tar.gz";
            tmp = new File(exportDir, name);
            tmpTar = new File(exportDir, "rootfs-" + stamp + ".tar");

            pack(app, rootfs, tmp, tmpTar);
            final long size = tmp.length();
            if (size <= 0) throw new ExportError("打包产物是 0 字节");

            // 打包阶段结束：进度改由拷贝循环报
            watch = null;
            bytes = 0L;
            phase = "复制到下载";
            log("打包完成 " + human(size) + "，开始复制到下载目录");

            Uri uri = copyToDownload(app, tmp, name);

            shareUri = (uri == null) ? "" : uri.toString();
            shareName = name;
            shareSize = size;
            result = "已导出 " + name + " · " + human(size) + " · 在「下载/" + DIR_NAME + "」里";
            log(result);
            state = OK;
        } catch (Throwable t) {
            String why = (t instanceof ExportError) ? t.getMessage() : whyOf(t);
            result = "导出失败：" + why;
            log(result);
            state = FAIL;
        } finally {
            watch = null;
            // 中间文件无论成败都删：rootfs 那点空间经不起两份
            deleteQuietly(tmpTar);
            deleteQuietly(tmp);
            if (exportDir.exists()) deleteTree(exportDir);
            seq++;
            BridgeService.push("[导出] " + (state == OK ? "完成" : "结束"));
        }
    }

    // ───────────────────────── 打包：tar -z 优先，退 tar + gzip ─────────────────────────

    private static void pack(Context app, File rootfs, File tmp, File tmpTar) throws Exception {
        if (tarGzSupported(app)) {
            phase = "打包（tar -z）";
            watch = tmp;
            log("用 /system/bin/tar czf 打包");
            Run r = exec(new String[]{
                    "/system/bin/tar", "czf", tmp.getAbsolutePath(),
                    "-C", rootfs.getAbsolutePath(), "."}, 0L);
            // GNU tar 的 1 = "有文件在打包时被改动"（容器还活着时很常见），产物仍可用
            if (r.code == 0 || r.code == 1) {
                if (!isGzip(tmp)) throw new ExportError("tar 退出码 " + r.code + "，但产物不是 gzip：" + head(r.out));
                if (r.code == 1) log("tar 警告（打包时有文件变动，产物仍可用）");
                return;
            }
            // 真失败：把半成品清掉，报清楚是 tar 的哪个退出码
            deleteQuietly(tmp);
            throw new ExportError("tar 退出码 " + r.code + (r.timedOut ? "（超时）" : "")
                    + "：" + head(r.out));
        }

        // 两步法：tar cf 出 .tar，再用 GZIPOutputStream 流式压（8KB 缓冲，绝不整块读进内存）
        phase = "打包（tar + gzip）";
        watch = tmpTar;
        log("/system/bin/tar 不支持 -z，改两步：tar cf → GZIPOutputStream");
        Run r = exec(new String[]{
                "/system/bin/tar", "cf", tmpTar.getAbsolutePath(),
                "-C", rootfs.getAbsolutePath(), "."}, 0L);
        if (r.code != 0 && r.code != 1) {
            throw new ExportError("tar 退出码 " + r.code + (r.timedOut ? "（超时）" : "")
                    + "：" + head(r.out));
        }
        if (!tmpTar.exists() || tmpTar.length() <= 0) throw new ExportError("tar cf 之后没有 .tar 产物");
        phase = "压缩（gzip）";
        watch = tmp;
        gzip(tmpTar, tmp);
        deleteQuietly(tmpTar);
    }

    /** 探测 /system/bin/tar 是否支持 -z：直接拿一个小目录试一次，比看 --help 可靠 */
    private static boolean tarGzSupported(Context app) {
        synchronized (LOCK) {
            if (tarGzProbe >= 0) return tarGzProbe == 1;
            File dir = new File(app.getCacheDir(), "tarz-probe");
            File gz = new File(app.getCacheDir(), "tarz-probe.tar.gz");
            boolean ok = false;
            try {
                deleteTree(dir);
                deleteQuietly(gz);
                if (!dir.mkdirs()) return false;
                writeText(new File(dir, "a.txt"), "probe\n");
                Run r = exec(new String[]{
                        "/system/bin/tar", "czf", gz.getAbsolutePath(),
                        "-C", dir.getAbsolutePath(), "."}, 15000L);
                ok = r.code == 0 && gz.length() > 10 && isGzip(gz);
                if (!ok) log("探测：/system/bin/tar 不支持 -z（code=" + r.code + "），走 tar+gzip");
            } catch (Throwable t) {
                ok = false;
                log("探测 tar -z 出错：" + t.getMessage() + "，走 tar+gzip");
            } finally {
                deleteTree(dir);
                deleteQuietly(gz);
            }
            tarGzProbe = ok ? 1 : 0;
            return ok;
        }
    }

    /** .tar → .tar.gz，8KB 缓冲；进度按产物大小回读 */
    private static void gzip(File src, File dst) throws IOException {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = new GZIPOutputStream(new BufferedOutputStream(new FileOutputStream(dst), 8192));
            byte[] buf = new byte[8192];
            int n;
            int tick = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                // 每 1MB 看一眼产物大小，别每 8KB 都 stat
                if ((++tick & 127) == 0) bytes = dst.length();
            }
        } finally {
            try { if (out != null) out.close(); } catch (Throwable ignored) { }
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
        bytes = dst.length();
    }

    // ───────────────────────── 落到「下载/qq-bridge」 ─────────────────────────

    /**
     * API ≥ 29 走 MediaStore.Downloads（免权限）；
     * API < 29 直接写公共 Downloads 目录 + MediaScanner 收录（要 WRITE_EXTERNAL_STORAGE）。
     * 返回可分享的 content Uri。
     */
    private static Uri copyToDownload(Context app, File src, String name) throws IOException {
        final ContentResolver cr = app.getContentResolver();
        final long total = src.length();

        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, "application/gzip");
            v.put(MediaStore.Downloads.RELATIVE_PATH, "Download/" + DIR_NAME);
            v.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("MediaStore 插入失败（下载目录不可写？）");
            try {
                OutputStream os = cr.openOutputStream(uri);
                stream(src, os, total);
            } catch (Throwable t) {
                try { cr.delete(uri, null, null); } catch (Throwable ignored) { }
                throw new IOException(whyOf(t), t);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            return uri;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS), DIR_NAME);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("建不了下载目录：" + dir.getPath());
        File dst = unique(dir, name);
        OutputStream os = null;
        try {
            os = new FileOutputStream(dst);
            stream(src, os, total);
        } finally {
            try { if (os != null) os.close(); } catch (Throwable ignored) { }
        }
        MediaScannerConnection.scanFile(app,
                new String[]{dst.getAbsolutePath()}, new String[]{"application/gzip"}, null);

        // 没有 FileProvider：想要能授给微信/网盘读的 Uri，只能自己在 MediaStore 里登记一条
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Files.FileColumns.DATA, dst.getAbsolutePath());
            v.put(MediaStore.Files.FileColumns.DISPLAY_NAME, dst.getName());
            v.put(MediaStore.Files.FileColumns.MIME_TYPE, "application/gzip");
            v.put(MediaStore.Files.FileColumns.DATE_ADDED, System.currentTimeMillis() / 1000);
            return cr.insert(MediaStore.Files.getContentUri("external"), v);
        } catch (Throwable ignored) {
            return null;   // 分享按钮会因此置灰，但文件已经在下载目录里了
        }
    }

    /** 8KB 缓冲的流式拷贝；每 1MB 回读一次进度 */
    private static void stream(File src, OutputStream os, long total) throws IOException {
        if (os == null) throw new IOException("打不开输出流");
        InputStream in = null;
        try {
            in = new FileInputStream(src);
            byte[] buf = new byte[8192];
            long done = 0;
            int n;
            int tick = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                done += n;
                if ((++tick & 127) == 0) bytes = done;
            }
            bytes = done;
            try { os.flush(); } catch (Throwable ignored) { }
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
            try { os.close(); } catch (Throwable ignored) { }
        }
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 100; i++) {
            File c = new File(dir, base + "-" + i + ext);
            if (!c.exists()) return c;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    // ───────────────────────── 进程执行 ─────────────────────────

    private static final class Run {
        int code = -1;
        String out = "";
        boolean timedOut = false;
    }

    /** 跑一条命令并收输出（超时 <=0 表示不设上限）。输出边读边丢，绝不会把管道堵死。 */
    private static Run exec(String[] cmd, long timeoutMs) {
        final Run r = new Run();
        final Process p;
        try {
            p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        } catch (Throwable t) {
            r.out = String.valueOf(t.getMessage());
            return r;
        }
        final StringBuilder sb = new StringBuilder();
        Thread reader = new Thread(new Runnable() {
            @Override public void run() {
                BufferedReader br = null;
                try {
                    br = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = br.readLine()) != null) {
                        synchronized (sb) {
                            if (sb.length() < 4000) sb.append(line).append('\n');
                        }
                    }
                } catch (Throwable ignored) {
                } finally {
                    try { if (br != null) br.close(); } catch (Throwable ignored) { }
                }
            }
        }, "qb-tar-out");
        reader.setDaemon(true);
        reader.start();

        java.util.Timer wd = null;
        final boolean[] to = { false };
        if (timeoutMs > 0) {
            wd = new java.util.Timer(true);
            wd.schedule(new java.util.TimerTask() {
                @Override public void run() {
                    to[0] = true;
                    try { p.destroy(); } catch (Throwable ignored) { }
                }
            }, timeoutMs);
        }
        try {
            r.code = p.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            try { p.destroy(); } catch (Throwable ignored) { }
        }
        if (wd != null) wd.cancel();
        try { reader.join(1500); } catch (InterruptedException ignored) { }
        r.timedOut = to[0];
        synchronized (sb) { r.out = sb.toString(); }
        return r;
    }

    /** 每秒看一眼产物大小 —— 就是「读文件大小即可」的进度 */
    private static void startWatcher() {
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                while (state == RUN) {
                    try {
                        Thread.sleep(1000L);
                    } catch (InterruptedException e) {
                        return;
                    }
                    File f = watch;
                    if (f != null && state == RUN) {
                        long len = f.exists() ? f.length() : 0L;
                        if (len > bytes) bytes = len;
                    }
                }
            }
        }, "qb-export-watch");
        t.setDaemon(true);
        t.start();
    }

    // ───────────────────────── 杂项 ─────────────────────────

    /** 源目录大小：优先 du（几十万文件也很快），拿不到再 Java 走一遍（只 stat，不读内容） */
    private static long dirSize(File dir) {
        try {
            Run r = exec(new String[]{"/system/bin/du", "-sk", dir.getAbsolutePath()}, 60000L);
            if (r.code == 0) {
                String s = r.out.trim();
                int i = 0;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                if (i > 0) return Long.parseLong(s.substring(0, i)) * 1024L;
            }
        } catch (Throwable ignored) { }
        return walk(dir);
    }

    private static long walk(File f) {
        if (f == null) return 0L;
        if (f.isFile()) return f.length();
        File[] kids = f.listFiles();
        if (kids == null) return 0L;
        long sum = 0L;
        for (File k : kids) sum += walk(k);
        return sum;
    }

    private static long avail(File path) {
        try {
            return new StatFs(path.getAbsolutePath()).getAvailableBytes();
        } catch (Throwable t) {
            return -1L;
        }
    }

    private static long availOut(Context app) {
        try {
            File p = Build.VERSION.SDK_INT >= 29
                    ? Environment.getExternalStorageDirectory()
                    : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (p != null) return new StatFs(p.getAbsolutePath()).getAvailableBytes();
        } catch (Throwable ignored) { }
        try {
            File d = app.getExternalFilesDir(null);
            if (d != null) return new StatFs(d.getAbsolutePath()).getAvailableBytes();
        } catch (Throwable ignored) { }
        return -1L;
    }

    private static boolean isGzip(File f) {
        if (f == null || !f.exists() || f.length() < 2) return false;
        InputStream in = null;
        try {
            in = new FileInputStream(f);
            int a = in.read();
            int b = in.read();
            return a == 0x1f && b == 0x8b;
        } catch (Throwable t) {
            return false;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
    }

    private static void deleteQuietly(File f) {
        try { if (f != null && f.isFile()) f.delete(); } catch (Throwable ignored) { }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        try {
            if (f.isDirectory()) {
                File[] kids = f.listFiles();
                if (kids != null) for (File k : kids) deleteTree(k);
            }
            f.delete();
        } catch (Throwable ignored) { }
    }

    private static void writeText(File f, String text) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(text.getBytes("UTF-8")); } finally {
            try { out.close(); } catch (Throwable ignored) { }
        }
    }

    private static String head(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.length() == 0) return "";
        int nl = t.indexOf('\n');
        if (nl > 0) t = t.substring(0, nl);
        return t.length() > 200 ? t.substring(0, 200) : t;
    }

    /** 把异常翻译成用户能看懂的一句话（空间/权限/退出码分开说） */
    private static String whyOf(Throwable t) {
        String m = String.valueOf(t.getMessage());
        String low = m.toLowerCase(Locale.US);
        if (low.contains("enospc") || low.contains("no space")) return "空间不足，写不下了";
        if (low.contains("eacces") || low.contains("permission denied")) return "没有权限写这个目录";
        if (t instanceof IOException && (m == null || m.length() == 0 || "null".equals(m))) {
            return "读写失败（" + t.getClass().getSimpleName() + "）";
        }
        return m;
    }

    static String human(long b) {
        if (b < 0) return "?";
        if (b >= (1L << 30)) return String.format(Locale.US, "%.2f GB", b / 1073741824.0);
        if (b >= (1L << 20)) return String.format(Locale.US, "%.0f MB", b / 1048576.0);
        if (b >= (1L << 10)) return String.format(Locale.US, "%.0f KB", b / 1024.0);
        return b + " B";
    }

    private static void log(String msg) {
        BridgeService.push("[导出] " + msg);
    }

    /** 我们自己造的错误：message 就是要直接上屏的那句话 */
    static final class ExportError extends Exception {
        ExportError(String msg) { super(msg); }
    }
}
