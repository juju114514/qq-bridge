package com.qqbridge.app;

import android.content.Context;
import android.os.StatFs;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * v9：「安装 AstrBot」—— 用随包的离线 wheelhouse 在容器里装好 AstrBot 并拉起 WebUI。
 *
 * 与 RootfsExporter 一样的规矩：
 *  1. **不碰主线程**：整件事跑在 "qb-astrbot" 线程；界面只读这里的静态字段（state/phase/seq）。
 *  2. **大文件流式走**：assets 里 138MB 的 wheels.tar 用 64KB 缓冲拷到私有目录，按字数回读进度。
 *  3. **guest 里的东西交给 guest**：解 tar 用 /system/bin/tar，apt/pip 走 BridgeService.proot
 *     （这条路径 StageB 已经踩过：apt 要跑几分钟，必须边跑边上屏）。
 *
 * 路径约定（容器的 /tmp 就是 getFilesDir()/app/tmp 的 bind）：
 *   files/app/tmp/wheels               → guest /tmp/wheels
 *   files/app/tmp/astrbot              → guest /tmp/astrbot
 *   files/app/tmp/requirements.lock.txt → guest /tmp/requirements.lock.txt
 *   files/app/rootfs/root/astrbot      → guest /root/astrbot（venv 在这里）
 */
final class AstrBotInstaller {

    static final int IDLE = 0;
    static final int RUN = 1;
    static final int OK = 2;
    static final int FAIL = 3;

    static final int PORT = 6185;
    static final String URL = "http://127.0.0.1:" + PORT;

    /** 界面直接读（写端只有安装线程 / 监视线程） */
    static volatile int state = IDLE;
    static volatile String phase = "";
    static volatile String failKind = "";
    static volatile String detail = "";
    /** 每次结束 +1，界面靠它去重 */
    static volatile int seq = 0;
    /** AstrBot 进程是否已经退出（监视线程置位，等启动循环据此提前结束） */
    static volatile boolean procExited = false;
    /** 从 AstrBot 日志里抓到的默认账号密码 */
    static volatile String username = "";
    static volatile String password = "";

    private static final String TAG = "qqb";
    private static final Object LOCK = new Object();
    /** 失败时贴多少行 */
    private static final int TAIL = 20;

    /** AstrBot 首次启动会打印「➜ Initial username: astrbot / ➜ Initial password: xxx」 */
    private static final Pattern RE_USER =
            Pattern.compile("(?:Initial\\s+)?[Uu]sername:\\s*([^\\s\"]+)");
    private static final Pattern RE_PASS =
            Pattern.compile("(?:Initial\\s+)?[Pp]assword:\\s*([^\\s\"]+)");

    private AstrBotInstaller() { }

    static boolean running() {
        return state == RUN;
    }

    static boolean installed() {
        return state == OK;
    }

    /** 返回 false 表示已经有一个在跑了 */
    static boolean start(Context ctx) {
        synchronized (LOCK) {
            if (state == RUN) return false;
            state = RUN;
            phase = "准备";
            failKind = "";
            detail = "";
            procExited = false;
            seq = 0;
        }
        final Context app = ctx.getApplicationContext();
        Thread t = new Thread(new Runnable() {
            @Override public void run() { work(app); }
        }, "qb-astrbot");
        t.setDaemon(true);
        t.start();
        return true;
    }

    // ───────────────────────── 主流程 ─────────────────────────

    private static void work(Context app) {
        try {
            final File base = new File(app.getFilesDir(), "app");
            final File tmp = new File(base, "tmp");
            if (!tmp.exists() && !tmp.mkdirs()) throw new Step("解包失败", "建不了临时目录 " + tmp);

            // wheels 138MB + venv 723MB + 源码，留 1.2GB 余量再动手，免得装到一半没空间
            long need = 1200L << 20;
            long avail = availBytes(base);
            if (avail > 0 && avail < need) {
                throw new Step("空间不足", "装 AstrBot 需要约 " + human(need)
                        + "，内部存储只剩 " + human(avail));
            }

            // ① 解包素材（assets → files/app/tmp）
            setPhase("① 解包素材（约 145MB）");
            File wheelsTar = new File(base, "astrbot-wheels.tar");
            copyOrFail(app, "astrbot-wheels.tar", wheelsTar, "wheels 包");
            File wheels = new File(tmp, "wheels");
            deleteTree(wheels);
            untar(wheelsTar, wheels, false);
            File[] whs = wheels.listFiles();
            if (whs == null || whs.length < 100) {
                throw new Step("解包失败", "/tmp/wheels 里只有 "
                        + (whs == null ? 0 : whs.length) + " 个文件（应该 150+）");
            }
            push("[AstrBot] wheels 就绪：" + whs.length + " 个文件");
            deleteQuietly(wheelsTar);

            File srcTar = new File(base, "astrbot-src.tar.gz");
            copyOrFail(app, "astrbot-src.tar.gz", srcTar, "AstrBot 源码");
            File src = new File(tmp, "astrbot");
            deleteTree(src);
            untar(srcTar, src, true);
            if (!new File(src, "main.py").exists()) {
                throw new Step("解包失败", "/tmp/astrbot 里没有 main.py");
            }
            push("[AstrBot] 源码就绪：" + src.getPath());
            deleteQuietly(srcTar);

            // lock 直接铺到 /tmp（guest 里的 /tmp 就是 base/tmp）
            copyOrFail(app, "requirements.lock.txt",
                    new File(tmp, "requirements.lock.txt"), "requirements.lock.txt");

            // ② guest 里准备运行环境
            setPhase("② 准备运行环境（apt）");
            String aptOut = run(base, APT_SCRIPT, 900000L);
            if (!aptOut.contains("APT_OK")) {
                throw new Step("apt 失败", "apt-get 没跑通（" + firstMark(aptOut) + "）\n"
                        + tail(aptOut, TAIL));
            }
            push("[AstrBot] 运行环境就绪");

            // ③ 建 venv + 离线装依赖
            setPhase("③ 建 venv + 离线装依赖（1~2 分钟）");
            String pipOut = run(base, PIP_SCRIPT, 1800000L);
            if (pipOut.contains("PIP_FAIL")) {
                throw new Step("pip 失败", "pip install 失败（末 20 行）\n" + tail(pipOut, TAIL));
            }
            if (!pipOut.contains("ALL_DONE")) {
                throw new Step("pip 失败", "pip 阶段没跑完（" + firstMark(pipOut) + "）\n"
                        + tail(pipOut, TAIL));
            }
            if (pipOut.contains("PIP_OK_FALLBACK")) {
                push("[AstrBot] lock 缺包，已回退 requirements.txt（联网补装）");
            }
            if (pipOut.contains("PIP_UPGRADE_SKIP")) {
                push("[AstrBot] pip 升级跳过（离线包不全），用自带 pip 继续");
            }
            push("[AstrBot] 依赖装完");

            // ④ 启动：AstrBot 跑在常驻 proot 里（见 startMonitorThread 注释）
            setPhase("④ 启动 AstrBot");
            startMonitorThread(base);

            // ⑤ 等 WebUI：日志出现 'AstrBot started.' 或 6185 可连
            setPhase("⑤ 等 WebUI（6185）");
            boolean ready = false;
            for (int i = 0; i < 40 && state == RUN && !procExited; i++) {
                if (probe(PORT)) { ready = true; break; }
                String out = run(base,
                        "if [ -f /root/astrbot.log ]; then "
                                + "grep -aq 'AstrBot started.' /root/astrbot.log && echo 'ASTRBOT_READY'; "
                                + "tail -n 1 /root/astrbot.log | cut -c1-140; "
                                + "else echo 'NO_LOG_YET'; fi", 60000L);
                if (out.contains("ASTRBOT_READY")) { ready = true; break; }
                String last = lastLine(out);
                setPhase("⑤ 等 WebUI " + ((i + 1) * 5) + "s" + (last.length() > 0 ? " · " + last : ""));
                try {
                    Thread.sleep(5000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            if (!ready) {
                String tailLog = run(base, "tail -n 20 /root/astrbot.log 2>/dev/null", 60000L);
                pushTail("[AstrBot] ", tailLog);
                if (procExited) {
                    throw new Step("启动失败", "python main.py 提前退出（日志尾部见上）\n"
                            + tail(tailLog, TAIL));
                }
                throw new Step("启动超时", "240s 内没等到 'AstrBot started.'，6185 也没监听（日志尾部见上）\n"
                        + tail(tailLog, TAIL));
            }

            // 账号密码：AstrBot 只在**首次**启动打印，之后抓不到就如实说
            String cred = run(base,
                    "grep -a -E 'sername:|assword:' /root/astrbot.log 2>/dev/null | tail -n 6", 60000L);
            username = pick(RE_USER, cred);
            password = pick(RE_PASS, cred);
            if (username.length() == 0) username = "astrbot";

            state = OK;
            setPhase("已就绪 · WebUI " + URL);
            push("[AstrBot] WebUI 已就绪 " + URL + " · 用户 " + username
                    + (password.length() > 0
                       ? " · 密码 " + password
                       : " · 密码：日志里没有（只在首次启动打印，见 /root/astrbot/data/cmd_config.json）"));
        } catch (Step s) {
            failKind = s.cat;
            detail = s.getMessage();
            state = FAIL;
            push("[AstrBot] 失败（" + failKind + "）：" + oneLine(s.getMessage()));
            Log.e(TAG, "astrbot install failed", s);
        } catch (Throwable t) {
            failKind = "安装失败";
            detail = String.valueOf(t.getMessage());
            state = FAIL;
            push("[AstrBot] 异常：" + detail);
            Log.e(TAG, "astrbot install crashed", t);
        } finally {
            seq++;
            BridgeService.push("[AstrBot] 结束（" + (state == OK ? "成功" : "失败") + "）");
        }
    }

    /**
     * AstrBot 本体跑在一个**常驻 proot** 里：proot 活着，guest 的路径映射才有效。
     * 用 setsid 丢到后台的话，proot 一退出 /root/astrbot/venv 这套路径就失效，
     * 进程会拿着「Android 根」去找 venv 里的 python —— 所以这里不后台化，让 proot 留在前台。
     */
    private static void startMonitorThread(final File base) {
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                try {
                    BridgeService.proot(base, START_SCRIPT, 86400000L);
                    BridgeService.push("[AstrBot] 进程已退出");
                    procExited = true;
                    if (state == OK) {
                        failKind = "AstrBot 已退出";
                        detail = "python main.py 结束了，看 /root/astrbot.log";
                        state = FAIL;
                        seq++;
                    }
                } catch (Throwable th) {
                    procExited = true;
                    BridgeService.push("[AstrBot] 启动进程异常：" + th);
                }
            }
        }, "qb-astrbot-run");
        t.setDaemon(true);
        t.start();
    }

    // ───────────────────────── guest 脚本 ─────────────────────────

    /** ② 运行环境：python3-venv/pip + curl/ca（ca 是 AstrBot 访问 HTTPS 模型接口要的） */
    private static final String APT_SCRIPT = String.join("\n",
            "export DEBIAN_FRONTEND=noninteractive",
            "echo 'APT_UPDATE'",
            "apt-get -o DPkg::Lock::Timeout=300 update -qq > /tmp/apt.log 2>&1 || { echo 'APT_FAIL_UPDATE'; tail -n 20 /tmp/apt.log; exit 21; }",
            "echo 'APT_INSTALL'",
            "apt-get -o DPkg::Lock::Timeout=300 install -y -qq python3-pip python3-venv curl ca-certificates "
                    + ">> /tmp/apt.log 2>&1 || { echo 'APT_FAIL_INSTALL'; tail -n 20 /tmp/apt.log; exit 22; }",
            "python3 -V",
            "echo 'APT_OK'");

    /** ③ venv + 离线装依赖；lock 装不上就退 requirements.txt（允许联网补缺的包） */
    private static final String PIP_SCRIPT = String.join("\n",
            "rm -rf /root/astrbot",
            "mkdir -p /root/astrbot",
            "cp -a /tmp/astrbot/. /root/astrbot/ || { echo 'SRC_FAIL'; exit 31; }",
            "cp -f /tmp/requirements.lock.txt /root/astrbot/requirements.lock.txt "
                    + "|| { echo 'SRC_FAIL'; exit 31; }",
            "cd /root/astrbot || exit 32",
            "echo 'VENV_BEGIN'",
            "python3 -m venv venv || { echo 'VENV_FAIL'; exit 33; }",
            ". venv/bin/activate || { echo 'VENV_FAIL'; exit 34; }",
            "pip install -U pip -q --no-index --find-links /tmp/wheels "
                    + ">/dev/null 2>&1 || echo 'PIP_UPGRADE_SKIP'",
            "echo 'PIP_BEGIN'",
            "if pip install --no-index --find-links /tmp/wheels -r /tmp/requirements.lock.txt "
                    + "> /tmp/pip.log 2>&1; then",
            "  echo 'PIP_OK_LOCK'",
            "else",
            "  echo 'PIP_FAIL_LOCK'",
            "  tail -n 20 /tmp/pip.log",
            "  echo 'PIP_BEGIN_FALLBACK'",
            "  if pip install --find-links /tmp/wheels -r /root/astrbot/requirements.txt "
                    + ">> /tmp/pip.log 2>&1; then",
            "    echo 'PIP_OK_FALLBACK'",
            "  else",
            "    echo 'PIP_FAIL'",
            "    tail -n 20 /tmp/pip.log",
            "    exit 35",
            "  fi",
            "fi",
            "echo 'PIP_DONE'",
            "rm -rf /tmp/wheels",
            "echo 'ALL_DONE'");

    /** ④ exec 掉 bash，让 proot 直接跟踪 python（父进程不退，路径映射就一直在） */
    private static final String START_SCRIPT =
            "cd /root/astrbot && . venv/bin/activate && "
                    + "exec python main.py > /root/astrbot.log 2>&1 < /dev/null";

    // ───────────────────────── 素材：拷贝 + 解包 ─────────────────────────

    private static void copyOrFail(Context app, String name, File dst, String label) throws Step {
        try {
            copyAsset(app, name, dst, label);
        } catch (IOException e) {
            throw new Step("解包失败", "复制 " + label + " 失败：" + e.getMessage());
        }
    }

    /** assets → 私有目录；138MB 的东西不读进堆，按 5% 报进度 */
    private static void copyAsset(Context app, String name, File dst, String label) throws IOException {
        if (dst.exists() && dst.length() > 0) {
            push("[AstrBot] " + label + " 已在硬盘（" + human(dst.length()) + "），跳过复制");
            return;
        }
        dst.getParentFile().mkdirs();
        InputStream in = null;
        FileOutputStream out = null;
        try {
            in = app.getAssets().open(name);
            long total = -1;
            try { total = in.available(); } catch (Throwable ignored) { }
            out = new FileOutputStream(dst);
            byte[] buf = new byte[1 << 16];
            int n;
            long got = 0;
            long step = -1;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                if (total > 0) {
                    long pct = got * 100 / total;
                    if (pct / 5 != step) {
                        step = pct / 5;
                        setPhase("① 解包素材 · 复制 " + label + " " + pct + "%");
                    }
                }
            }
            push("[AstrBot] 复制 " + label + " 完成（" + human(got) + "）");
        } finally {
            try { if (out != null) out.close(); } catch (Throwable ignored) { }
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
    }

    /** 交给 /system/bin/tar（Java 里不写 tar 解析器） */
    private static void untar(File tar, File dir, boolean gz) throws Step {
        if (!dir.exists() && !dir.mkdirs()) throw new Step("解包失败", "建目录失败 " + dir);
        String cmd = "cd '" + dir.getAbsolutePath() + "' && /system/bin/tar x"
                + (gz ? "z" : "") + "f '" + tar.getAbsolutePath() + "'";
        Process p = null;
        StringBuilder sb = new StringBuilder();
        try {
            p = new ProcessBuilder("/system/bin/sh", "-c", cmd).redirectErrorStream(true).start();
            BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
            String line;
            while ((line = br.readLine()) != null) {
                if (sb.length() < 3000) sb.append(line).append('\n');
            }
            int code = p.waitFor();
            if (code != 0) {
                throw new Step("解包失败", tar.getName() + " tar 退出码 " + code
                        + " · " + oneLine(sb.toString()));
            }
        } catch (IOException e) {
            throw new Step("解包失败", tar.getName() + " " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Step("解包失败", "被中断");
        } finally {
            if (p != null) { try { p.destroy(); } catch (Throwable ignored) { } }
        }
        push("[AstrBot] 解包 " + tar.getName() + " → " + dir.getAbsolutePath() + " 完成");
    }

    // ───────────────────────── 工具 ─────────────────────────

    /** 跑一段 guest 脚本，返回合并后的输出（BridgeService.proot 已经边跑边 push 上屏） */
    private static String run(File base, String script, long timeoutMs) throws IOException {
        String[] out = BridgeService.proot(base, script, timeoutMs);
        StringBuilder sb = new StringBuilder();
        for (String l : out) sb.append(l).append('\n');
        return sb.toString();
    }

    private static boolean probe(int port) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", port), 400);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    private static String pick(Pattern p, String text) {
        if (text == null || text.length() == 0) return "";
        Matcher m = p.matcher(text);
        String last = "";
        while (m.find()) last = m.group(1);
        return last == null ? "" : last;
    }

    private static String lastLine(String s) {
        if (s == null) return "";
        String[] ls = s.split("\n");
        for (int i = ls.length - 1; i >= 0; i--) {
            String t = ls[i].trim();
            if (t.length() > 0) return t;
        }
        return "";
    }

    /** 取最后 n 行（失败时贴给用户/剪贴板） */
    private static String tail(String s, int n) {
        if (s == null || s.length() == 0) return "（没有输出）";
        String[] ls = s.split("\n");
        int from = Math.max(0, ls.length - n);
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < ls.length; i++) {
            if (ls[i].length() == 0) continue;
            sb.append(ls[i]).append('\n');
        }
        return sb.toString();
    }

    private static void pushTail(String prefix, String block) {
        if (block == null) return;
        for (String l : block.split("\n")) {
            if (l.trim().length() > 0) push(prefix + l);
        }
    }

    /** 失败分类用：优先报脚本打出来的标记 */
    private static String firstMark(String out) {
        if (out != null) {
            for (String m : new String[]{"APT_FAIL_UPDATE", "APT_FAIL_INSTALL", "SRC_FAIL",
                    "VENV_FAIL", "PIP_FAIL_LOCK"}) {
                if (out.contains(m)) return m;
            }
        }
        return oneLine(out);
    }

    static String oneLine(String s) {
        if (s == null) return "";
        String t = s.trim().replace('\n', ' ');
        return t.length() > 200 ? t.substring(0, 200) : t;
    }

    private static void setPhase(String p) {
        phase = p;
        BridgeService.setStage("AstrBot " + p);
    }

    private static void push(String line) {
        BridgeService.push(line);
    }

    static String human(long b) {
        if (b < 0) return "?";
        if (b >= (1L << 30)) return String.format(Locale.US, "%.2f GB", b / 1073741824.0);
        if (b >= (1L << 20)) return String.format(Locale.US, "%.0f MB", b / 1048576.0);
        if (b >= (1L << 10)) return String.format(Locale.US, "%.0f KB", b / 1024.0);
        return b + " B";
    }

    /** 给「复制」按钮：把 AstrBot 这一段也带上（手机没 adb，剪贴板就是唯一取证方式） */
    static String summary() {
        StringBuilder sb = new StringBuilder();
        sb.append("---- AstrBot ----\n");
        sb.append("状态: ").append(state == OK ? "已就绪" : state == RUN ? "安装中" : state == FAIL ? "失败" : "未安装").append('\n');
        sb.append("阶段: ").append(phase).append('\n');
        if (state == OK) {
            sb.append("WebUI: ").append(URL).append('\n');
            sb.append("用户名: ").append(username).append('\n');
            sb.append("密码: ").append(password.length() > 0
                    ? password : "（日志里没有，见 /root/astrbot/data/cmd_config.json）").append('\n');
        }
        if (failKind.length() > 0) sb.append("失败分类: ").append(failKind).append('\n');
        if (detail.length() > 0) sb.append("详情: ").append(detail).append('\n');
        return sb.toString();
    }

    private static long availBytes(File path) {
        try {
            return new StatFs(path.getAbsolutePath()).getAvailableBytes();
        } catch (Throwable t) {
            return -1L;
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

    /** 我们自己造的错误：cat = 失败分类（解包失败 / apt 失败 / pip 失败 / 启动超时 / 空间不足） */
    static final class Step extends Exception {
        final String cat;

        Step(String cat, String msg) {
            super(msg);
            this.cat = cat;
        }

        String category() { return cat; }
    }
}
