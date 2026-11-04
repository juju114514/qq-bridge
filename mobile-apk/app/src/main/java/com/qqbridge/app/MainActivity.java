package com.qqbridge.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 一体化 APK 的入口：起前台服务 → 等桥接端口通 → 用 WebView 打开控制台。
 *
 * 诊断版（0.5.60）的两条硬规则：
 *   1. **界面上永远有字**：顶部工具条 + 可切换的日志面板，WebView 只在端口通之后才显示。
 *      之前 WebView 和提示各占一半（都 weight=1），结果 WebView 白底盖住文字，用户看到白屏 5 分钟。
 *   2. **失败要说人话**：解压失败 / node 退出 / 120 秒没监听，分别给不同提示，并且能一键复制日志
 *      （手机没有 adb 时，这是唯一的取证方式）。
 *
 * v6：扫码工具栏三个按钮（保存到相册 / 分享给 QQ / 用 QQ 打开）。
 *   · 没有 androidx、不能用 FileProvider（android.useAndroidX=false）→ 分享只能走 MediaStore 的 content Uri
 *   · targetSdk 28：API < 29 写公共目录要运行时申请 WRITE_EXTERNAL_STORAGE（29 走 MediaStore 免权限）
 *   · 二维码没出现时整条工具栏隐藏；登录链接没抓到就置灰并提示，不装作能用
 *
 * v8：「导出镜像」工具条（导出镜像 / 分享镜像）。
 *   · 导出整件事在 RootfsExporter 的后台线程里，界面只读静态状态（进度每秒刷一次）
 *   · 容器没就绪时按钮置灰但**仍可点** —— 点一下只会弹「容器还没就绪」，
 *     禁用了反而连原因都看不到（用户不知道要等什么）
 */
public class MainActivity extends Activity {

    private static final int CONSOLE_PORT = 3100;
    private static final int TIMEOUT_SECONDS = 180;
    private static final int REQ_STORAGE = 1001;
    private static final int PENDING_NONE = 0;
    private static final int PENDING_SAVE = 1;
    private static final int PENDING_SHARE = 2;
    private static final int PENDING_EXPORT = 3;
    /** NapCat 打印的登录链接：https://txz.qq.com/p?xxxxxxxx */
    private static final Pattern LOGIN_URL =
            Pattern.compile("https://txz\\.qq\\.com/p\\?[^\\s\"'）)]+");
    private static final String NO_LINK_HINT = "等 NapCat 日志出现登录链接";

    private Handler ui;
    private WebView web;
    private FrameLayout content;
    private ScrollView logPanel;
    private TextView stageText;
    private TextView logText;
    private Button toggleBtn;
    /** 阶段 B：QQ 登录二维码（文件一变就换图） */
    private ImageView qrView;
    private long qrStamp = -1L;

    /** 扫码工具栏（二维码出现才显示） */
    private LinearLayout qrBar;
    private Button saveBtn;
    private Button shareBtn;
    private Button openBtn;

    /** 导出工具栏（v8）：导出镜像 / 分享镜像 + 一行状态字 */
    private LinearLayout exportBar;
    private Button exportBtn;
    private Button exportShareBtn;
    private TextView exportNote;
    /** AstrBot 工具条（v9）：安装 AstrBot / 打开 AstrBot + 一行账号信息 */
    private LinearLayout astrBar;
    private Button astrBtn;
    private TextView astrNote;
    /** 装好后常驻显示：WebUI 地址 + 用户名/密码（手机没 adb，这是用户唯一能看的地方） */
    private TextView astrInfo;
    /** 上一次处理的 AstrBot 结束序号（去重） */
    private int seenAstrSeq = 0;
    /** 上一次的 AstrBot 状态（只在变化时改按钮，避免每 500ms 都 setText） */
    private int lastAstrState = -1;

    /** 上一次看到的 containerReady，用来只在变化时改按钮 */
    private boolean lastReady = false;
    /** 上一次处理的导出结束序号（去重，避免同一结果反复上屏） */
    private int seenExportSeq = 0;
    /** 进度节流：每秒刷一次就够 */
    private long lastProgressAt = 0L;
    /** 上一次的「有没有可分享的产物」 */
    private boolean lastHasShare = false;
    /** 顶部提示条：黄底一行，6~9 秒自动收，sticky 的留到条件消失 */
    private TextView hintView;
    private String hintText;
    private long hintUntil;
    /** 抓到的登录链接；二维码换一张就作废 */
    private String loginUrl;
    private int pendingAction = PENDING_NONE;

    private boolean webLoaded = false;
    private int seconds = 0;
    private boolean polling = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ui = new Handler(Looper.getMainLooper());

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // ── 工具条：阶段文字 + 三个按钮（永远可见）──
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(8);
        bar.setPadding(pad, pad, pad, pad);
        bar.setBackgroundColor(0xFF1B2430);

        stageText = new TextView(this);
        stageText.setTextSize(12);
        stageText.setTextColor(0xFFE6EEF8);
        stageText.setText("正在启动…");
        bar.addView(stageText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        toggleBtn = new Button(this);
        toggleBtn.setText("日志");
        toggleBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggleView(); }
        });
        bar.addView(toggleBtn);

        Button copy = new Button(this);
        copy.setText("复制");
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("qqb-diag", BridgeService.dump() + "\n" + AstrBotInstaller.summary()));
                stageText.setText("日志已复制到剪贴板");
            }
        });
        bar.addView(copy);

        Button retry = new Button(this);
        retry.setText("重连");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                seconds = 0;
                webLoaded = false;
                startBridge();
                showLogPanel();
                poll();
            }
        });
        bar.addView(retry);

        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ── 导出工具条（v8）：容器 rootfs → 下载/qq-bridge/rootfs-<时间戳>.tar.gz ──
        // 单独一行而不是塞进上面那排：上面已经有 3 个按钮 + 阶段文字，360dp 屏上再挤两个
        // 按钮会把阶段文字压成 0 宽（之前就因为挤掉过文字）。
        exportBar = new LinearLayout(this);
        exportBar.setOrientation(LinearLayout.HORIZONTAL);
        exportBar.setGravity(Gravity.CENTER_VERTICAL);
        exportBar.setPadding(pad, dp(2), pad, dp(3));
        exportBar.setBackgroundColor(0xFF16202B);

        exportBtn = addExportButton("导出镜像", new View.OnClickListener() {
            @Override public void onClick(View v) { exportImage(); }
        });
        exportShareBtn = addExportButton("分享镜像", new View.OnClickListener() {
            @Override public void onClick(View v) { shareImage(); }
        });
        exportShareBtn.setAlpha(0.45f);

        exportNote = new TextView(this);
        exportNote.setTextSize(10);
        exportNote.setTextColor(0xFF8FA6BF);
        exportNote.setPadding(dp(6), 0, 0, 0);
        exportNote.setText("容器还没就绪");
        exportBar.addView(exportNote, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        root.addView(exportBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ── AstrBot 工具条（v9）：离线 wheelhouse 装 AstrBot → 打开 WebUI ──
        // 单独一行：容器就绪后这一行才「亮」，容器没就绪时置灰但仍可点（点一下会说原因）。
        astrBar = new LinearLayout(this);
        astrBar.setOrientation(LinearLayout.HORIZONTAL);
        astrBar.setGravity(Gravity.CENTER_VERTICAL);
        astrBar.setPadding(pad, dp(2), pad, dp(3));
        astrBar.setBackgroundColor(0xFF1B2C3A);

        astrBtn = addAstrButton("安装 AstrBot", new View.OnClickListener() {
            @Override public void onClick(View v) { onAstrClick(); }
        });

        astrNote = new TextView(this);
        astrNote.setTextSize(10);
        astrNote.setTextColor(0xFF8FA6BF);
        astrNote.setPadding(dp(6), 0, 0, 0);
        astrNote.setText("容器还没就绪");
        astrBar.addView(astrNote, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        root.addView(astrBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 装好后常驻的一行：WebUI 地址 + 用户名/密码（换行显示，360dp 屏放得下）
        astrInfo = new TextView(this);
        astrInfo.setTextSize(11);
        astrInfo.setTextColor(0xFF9FE6B0);
        astrInfo.setBackgroundColor(0xFF13202B);
        astrInfo.setPadding(pad, dp(6), pad, dp(6));
        astrInfo.setVisibility(View.GONE);
        root.addView(astrInfo, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ── 扫码按钮条：二维码没出来之前整条隐藏（点了也没东西可存/可分享）──
        qrBar = new LinearLayout(this);
        qrBar.setOrientation(LinearLayout.HORIZONTAL);
        qrBar.setGravity(Gravity.CENTER_VERTICAL);
        qrBar.setPadding(pad, dp(2), pad, dp(4));
        qrBar.setBackgroundColor(0xFF22303F);
        qrBar.setVisibility(View.GONE);

        saveBtn = addQrButton("保存到相册", new View.OnClickListener() {
            @Override public void onClick(View v) { saveToGallery(); }
        });
        shareBtn = addQrButton("分享给 QQ", new View.OnClickListener() {
            @Override public void onClick(View v) { shareQr(); }
        });
        openBtn = addQrButton("用 QQ 打开", new View.OnClickListener() {
            @Override public void onClick(View v) { openWithQq(); }
        });

        root.addView(qrBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ── 顶部提示条（黄底）：任何按钮的结果都在这里说一句人话 ──
        hintView = new TextView(this);
        hintView.setTextSize(12);
        hintView.setTextColor(0xFF10202E);
        hintView.setBackgroundColor(0xFFFFD34D);
        hintView.setPadding(pad, dp(6), pad, dp(6));
        hintView.setVisibility(View.GONE);
        root.addView(hintView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ── 下半部分：WebView 与日志面板叠在一起，同一时刻只显示一个 ──
        content = new FrameLayout(this);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setVisibility(View.GONE);
        content.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        logPanel = new ScrollView(this);
        logPanel.setBackgroundColor(0xFF0E1726);
        logText = new TextView(this);
        logText.setTextSize(11);
        logText.setTextColor(0xFFD5E2F2);
        logText.setPadding(pad, pad, pad, pad);
        logPanel.addView(logText);
        content.addView(logPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        // 导出结果是静态状态：Activity 重建后接着显示，不重复上屏
        seenExportSeq = RootfsExporter.seq;
        seenAstrSeq = AstrBotInstaller.seq;
        startBridge();
        poll();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    /** 三个按钮等宽挤一行：字号调小 + 去掉默认 minWidth，否则 360dp 屏上会被截成「…」 */
    private Button addQrButton(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(11);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(2), dp(4), dp(2), dp(4));
        b.setOnClickListener(l);
        qrBar.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return b;
    }

    /** 导出工具条的按钮：和二维码那排一样压小字号，360dp 屏上两个按钮 + 状态字刚好放下 */
    private Button addExportButton(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(11);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(6), dp(4), dp(6), dp(4));
        b.setOnClickListener(l);
        exportBar.addView(b, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }

    /** AstrBot 那颗按钮：和导出按钮一样压小字号，320dp 屏上「安装 AstrBot」不会被截成省略号 */
    private Button addAstrButton(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(11);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(6), dp(4), dp(6), dp(4));
        b.setOnClickListener(l);
        astrBar.addView(b, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }

    private void startBridge() {
        try {
            Intent it = new Intent(this, BridgeService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(it); else startService(it);
        } catch (Throwable t) {
            stageText.setText("启动服务被拒：" + t.getMessage());
        }
    }

    private void showLogPanel() {
        web.setVisibility(View.GONE);
        logPanel.setVisibility(View.VISIBLE);
        toggleBtn.setText("日志");
    }

    private void toggleView() {
        if (web.getVisibility() == View.VISIBLE) {
            showLogPanel();
        } else if (webLoaded) {
            web.setVisibility(View.VISIBLE);
            logPanel.setVisibility(View.GONE);
            toggleBtn.setText("界面");
        } else {
            showLogPanel();
        }
    }

    // ───────────────────────── 顶部提示 ─────────────────────────

    /** 显示一条会过期的提示（millis 后自动收） */
    private void showHint(String msg, long millis) {
        hintText = msg;
        hintUntil = System.currentTimeMillis() + millis;
        applyHint();
    }

    /** 条件性提示：条件还在就一直显示，条件消失由调用方清掉 */
    private void setStickyHint(String msg) {
        if (msg == null) {
            if (NO_LINK_HINT.equals(hintText)) { hintText = null; hintUntil = 0L; }
        } else {
            hintText = msg;
            hintUntil = 0L;
        }
        applyHint();
    }

    private void applyHint() {
        if (hintText == null) {
            hintView.setVisibility(View.GONE);
            return;
        }
        hintView.setText(hintText);
        hintView.setVisibility(View.VISIBLE);
    }

    /** poll 每 500ms 调一次：把过期提示收掉，别让黄条一直挂着 */
    private void expireHint() {
        if (hintText == null) return;
        if (hintUntil > 0 && System.currentTimeMillis() > hintUntil) {
            hintText = null;
            hintUntil = 0L;
            if (loginUrl == null && qrBar.getVisibility() == View.VISIBLE) hintText = NO_LINK_HINT;
            applyHint();
        }
    }

    // ───────────────────────── 二维码工具栏 ─────────────────────────

    /** 二维码文件出现的每一个 tick 都走这里：按钮显出来 + 找登录链接 */
    private void onQrTick(File png) {
        if (qrBar.getVisibility() != View.VISIBLE) {
            qrBar.setVisibility(View.VISIBLE);
            saveBtn.setEnabled(true);
            shareBtn.setEnabled(true);
        }
        if (loginUrl == null) refreshLoginUrl();
    }

    /** 从 qr.txt / NapCat 日志里抓登录链接；抓不到就把「用 QQ 打开」置灰 */
    private void refreshLoginUrl() {
        String url = findLoginUrl();
        loginUrl = url;
        if (url == null) {
            openBtn.setEnabled(false);
            openBtn.setAlpha(0.45f);
            setStickyHint(NO_LINK_HINT);
        } else {
            openBtn.setEnabled(true);
            openBtn.setAlpha(1f);
            setStickyHint(null);
        }
    }

    private String findLoginUrl() {
        String hit = matchLogin(qrText());
        if (hit != null) return hit;
        // qr.txt 里只留了 grep 的最后一行，日志里可能还有更新的
        String[] tail = BridgeService.tail(60);
        for (int i = tail.length - 1; i >= 0; i--) {
            hit = matchLogin(tail[i]);
            if (hit != null) return hit;
        }
        return null;
    }

    private static String matchLogin(String s) {
        if (s == null || s.length() == 0) return null;
        Matcher m = LOGIN_URL.matcher(s);
        return m.find() ? m.group() : null;
    }

    /** qr.txt：NapCat 日志里 grep 出来的那一行（最多 8KB，够用） */
    private String qrText() {
        File f = BridgeService.qrTxt();
        if (f == null || !f.exists() || f.length() == 0) return "";
        InputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] buf = new byte[(int) Math.min(8192, f.length())];
            int n = in.read(buf);
            return new String(buf, 0, Math.max(n, 0), "UTF-8");
        } catch (Throwable t) {
            return "";
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
    }

    // ───────────────────────── 1. 保存到相册 ─────────────────────────

    private void saveToGallery() {
        final File png = BridgeService.qrPng();
        if (png == null || !png.exists()) {
            showHint("二维码还没出现，稍等", 4000);
            return;
        }
        if (!hasStoragePerm()) {
            pendingAction = PENDING_SAVE;
            requestStorage();
            return;
        }
        String name = "qrcode-" + stamp() + ".png";
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                // Q+：MediaStore 直接落 Pictures/qq-bridge，不用任何权限
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/qq-bridge");
                v.put(MediaStore.Images.Media.IS_PENDING, 1);
                ContentResolver cr = getContentResolver();
                Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("相册插入返回 null");
                try {
                    OutputStream os = cr.openOutputStream(uri);
                    copyTo(png, os);
                } catch (Throwable t) {
                    try { cr.delete(uri, null, null); } catch (Throwable ignored) { }
                    throw new IOException("写入相册失败：" + t.getMessage());
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                cr.update(uri, done, null, null);
            } else {
                // 老系统：直接写公共 Pictures 目录，再让 MediaScanner 收录
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_PICTURES), "qq-bridge");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("建目录失败：" + dir);
                File dst = new File(dir, name);
                OutputStream os = new FileOutputStream(dst);
                copyTo(png, os);
                MediaScannerConnection.scanFile(this,
                        new String[]{dst.getAbsolutePath()}, new String[]{"image/png"}, null);
            }
            showHint("已存相册：QQ 扫一扫 → 右上角相册", 8000);
        } catch (Throwable t) {
            showHint("存相册失败：" + t.getMessage(), 8000);
        }
    }

    // ───────────────────────── 2. 分享给 QQ ─────────────────────────

    private void shareQr() {
        final File png = BridgeService.qrPng();
        if (png == null || !png.exists()) {
            showHint("二维码还没出现，稍等", 4000);
            return;
        }
        if (!hasStoragePerm()) {
            pendingAction = PENDING_SHARE;
            requestStorage();
            return;
        }
        try {
            // 没有 FileProvider：只能先插进 MediaStore 拿 content:// Uri
            Uri uri = publishPng(png, "qrcode-" + stamp() + ".png");
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/png");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newUri(getContentResolver(), "qrcode", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "分享二维码图片");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(chooser);
            showHint("在 QQ 里长按图片 → 识别二维码", 8000);
        } catch (Throwable t) {
            showHint("分享失败：" + t.getMessage(), 8000);
        }
    }

    /** 把 PNG 写进 MediaStore，返回可授给别的 App 读取的 content Uri（29+ 落相册，28- 走 DATA） */
    private Uri publishPng(File png, String name) throws IOException {
        ContentResolver cr = getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/qq-bridge");
            v.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("相册插入返回 null");
            try {
                OutputStream os = cr.openOutputStream(uri);
                copyTo(png, os);
            } catch (Throwable t) {
                try { cr.delete(uri, null, null); } catch (Throwable ignored) { }
                throw new IOException("写入相册失败：" + t.getMessage());
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            return uri;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_PICTURES), "qq-bridge");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("建目录失败：" + dir);
        File dst = new File(dir, name);
        OutputStream os = new FileOutputStream(dst);
        copyTo(png, os);
        MediaScannerConnection.scanFile(this,
                new String[]{dst.getAbsolutePath()}, new String[]{"image/png"}, null);
        ContentValues v = new ContentValues();
        v.put(MediaStore.Images.Media.DATA, dst.getAbsolutePath());
        v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        v.put(MediaStore.Images.Media.DATE_ADDED, System.currentTimeMillis() / 1000);
        Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("相册插入返回 null");
        return uri;
    }

    // ───────────────────────── 3. 用 QQ 打开 ─────────────────────────

    private void openWithQq() {
        if (loginUrl == null) {
            showHint(NO_LINK_HINT, 6000);
            return;
        }
        Uri u = Uri.parse(loginUrl);
        Intent view = new Intent(Intent.ACTION_VIEW, u);
        view.setPackage("com.tencent.mobileqq");
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(view);
            showHint("已用 QQ 打开登录链接", 6000);
            return;
        } catch (Throwable ignored) {
            // 没装 QQ / QQ 不收这个 scheme：退到浏览器
        }
        try {
            Intent plain = new Intent(Intent.ACTION_VIEW, u);
            plain.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(plain);
            showHint("没装 QQ？已交给浏览器打开", 6000);
        } catch (Throwable t) {
            showHint("打不开登录链接：" + t.getMessage(), 8000);
        }
    }

    // ───────────────────────── 4. 导出容器镜像（v8） ─────────────────────────

    /**
     * 把 getFilesDir()/app/rootfs 打成 tar.gz 放到「下载/qq-bridge」。
     * 打包在 RootfsExporter 的线程里跑（main thread 只发号施令），界面靠 poll() 每秒读进度。
     */
    private void exportImage() {
        if (!BridgeService.containerReady) {
            showHint("容器还没就绪（等容器探针输出 CONTAINER_OK 再试）", 8000);
            return;
        }
        if (RootfsExporter.running()) {
            showHint("导出已经在跑了，别重复点", 5000);
            return;
        }
        final File rootfs = RootfsExporter.rootfsDir(this);
        if (!rootfs.isDirectory()) {
            showHint("找不到容器目录：" + rootfs.getPath(), 10000);
            return;
        }
        if (!hasStoragePerm()) {
            pendingAction = PENDING_EXPORT;
            requestStorage();
            return;
        }
        if (!RootfsExporter.start(this, rootfs)) {
            showHint("导出已经在跑了，别重复点", 5000);
            return;
        }
        lastProgressAt = 0L;
        exportNote.setText("导出中…");
        showHint("导出中… 别退出 App（体积可能 1~2 GB，要几分钟）", 8000);
    }

    /** 分享同一份产物：走 MediaStore 的 content Uri，可直接发微信/网盘 */
    private void shareImage() {
        final String uriStr = RootfsExporter.shareUri;
        if (uriStr == null || uriStr.length() == 0) {
            showHint("先点「导出镜像」，成功后才能分享", 7000);
            return;
        }
        try {
            Uri uri = Uri.parse(uriStr);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/gzip");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newUri(getContentResolver(), RootfsExporter.shareName, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "分享容器镜像");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(chooser);
            showHint("选微信/网盘发出去（" + RootfsExporter.human(RootfsExporter.shareSize)
                    + "，大文件建议直接 USB 拷）", 9000);
        } catch (Throwable t) {
            showHint("分享失败：" + t.getMessage(), 8000);
        }
    }

    /**
     * 每个 poll tick 调一次（500ms）：按钮灰度跟 containerReady 走，进度每秒刷一次，
     * 结果只在 seq 变化时上屏一次。
     */
    private void tickExport() {
        final boolean ready = BridgeService.containerReady;
        if (ready != lastReady) {
            lastReady = ready;
            // 置灰但仍可点：点一下会弹「容器还没就绪」，禁用了用户就看不到原因了
            exportBtn.setAlpha(ready ? 1f : 0.45f);
            exportNote.setText(ready ? "容器已就绪" : "容器还没就绪");
        }

        final boolean run = RootfsExporter.running();
        if (run) {
            long now = System.currentTimeMillis();
            if (now - lastProgressAt >= 1000L) {
                lastProgressAt = now;
                // 直接写 hintText：hintUntil 一直往后推，这条提示在导出期间不会过期
                hintText = "导出中… " + RootfsExporter.phase + " 已用 "
                        + RootfsExporter.human(RootfsExporter.bytes) + "（别退出 App）";
                hintUntil = now + 8000L;
                applyHint();
                exportNote.setText("导出中… " + RootfsExporter.human(RootfsExporter.bytes));
            }
        }

        final int seq = RootfsExporter.seq;
        if (seq != seenExportSeq) {
            seenExportSeq = seq;
            boolean ok = RootfsExporter.state == RootfsExporter.OK;
            String msg = RootfsExporter.result;
            if (msg != null && msg.length() > 0) showHint(msg, 20000);
            exportNote.setText(ok ? "已导出 " + RootfsExporter.human(RootfsExporter.shareSize) : "导出失败");
        }

        // 分享按钮只看「有没有可分享的产物」：Activity 重建 / 进程被回收后都能自己恢复
        final boolean has = RootfsExporter.shareUri != null && RootfsExporter.shareUri.length() > 0;
        if (has != lastHasShare) {
            lastHasShare = has;
            exportShareBtn.setAlpha(has ? 1f : 0.45f);
        }
    }

    // ───────────────────────── 5. 安装 AstrBot（v9） ─────────────────────────

    /**
     * 三态点击：
     *  · 已装好 → 按钮已变「打开 AstrBot」，点它是开 WebUI（不重装）
     *  · 正在装 → 只说一句，不重复起线程
     *  · 没装 → 必须 containerReady；否则只说原因（按钮置灰但**仍可点**）
     */
    private void onAstrClick() {
        if (AstrBotInstaller.installed()) {
            openAstrBot();
            return;
        }
        if (AstrBotInstaller.running()) {
            showLogPanel();
            showHint("正在装 AstrBot（" + AstrBotInstaller.phase + "），别重复点", 6000);
            return;
        }
        if (!BridgeService.containerReady) {
            showHint("容器还没就绪（等探针输出 CONTAINER_OK）再装 AstrBot", 9000);
            return;
        }
        if (!AstrBotInstaller.start(this)) {
            showHint("正在装 AstrBot，别重复点", 5000);
            return;
        }
        seenAstrSeq = AstrBotInstaller.seq;
        lastAstrState = -1;
        showLogPanel();
        showHint("开始装 AstrBot：解包 → apt → 离线 pip → 启动（约 1~2 分钟）", 10000);
    }

    /** 用内嵌 WebView 打开 guest 里的 AstrBot WebUI（proot 不隔离网络，127.0.0.1:6185 直连） */
    private void openAstrBot() {
        try {
            web.loadUrl(AstrBotInstaller.URL);
            web.setVisibility(View.VISIBLE);
            logPanel.setVisibility(View.GONE);
            toggleBtn.setText("界面");
            webLoaded = true;
            showHint("已打开 AstrBot WebUI：" + AstrBotInstaller.URL, 8000);
        } catch (Throwable t) {
            showHint("打开 WebUI 失败：" + t.getMessage(), 8000);
        }
    }

    /**
     * 每个 poll tick（500ms）调一次：
     *  · 按钮文案/灰度跟「容器是否就绪 + AstrBot 状态」走
     *  · 装好后把 WebUI 地址 + 用户名/密码常驻在屏幕上
     *  · 结束只在 seq 变化时上屏一次（成功给密码，失败自动切日志面板）
     */
    private void tickAstrBot() {
        final boolean ready = BridgeService.containerReady;
        final int st = AstrBotInstaller.state;

        if (st != lastAstrState) {
            lastAstrState = st;
            astrBtn.setText(st == AstrBotInstaller.OK ? "打开 AstrBot" : "安装 AstrBot");
            astrBtn.setAlpha((ready || st == AstrBotInstaller.OK) ? 1f : 0.45f);
        }

        if (st == AstrBotInstaller.RUN) {
            astrNote.setText(AstrBotInstaller.phase);
        } else if (st == AstrBotInstaller.OK) {
            astrNote.setText("已装好 · 6185 已监听");
            if (astrInfo.getVisibility() != View.VISIBLE) {
                astrInfo.setText("AstrBot WebUI " + AstrBotInstaller.URL
                        + "\n用户名 " + AstrBotInstaller.username
                        + " · 密码 " + pwdText());
                astrInfo.setVisibility(View.VISIBLE);
            }
        } else if (st == AstrBotInstaller.FAIL) {
            astrNote.setText("失败：" + AstrBotInstaller.failKind + "（点「复制」发我）");
            if (astrInfo.getVisibility() == View.VISIBLE) astrInfo.setVisibility(View.GONE);
        } else {
            astrNote.setText(ready ? "未安装（离线 wheels 随包带）" : "容器还没就绪");
        }

        final int seq = AstrBotInstaller.seq;
        if (seq != seenAstrSeq) {
            seenAstrSeq = seq;
            if (st == AstrBotInstaller.OK) {
                showHint("AstrBot 装好了：" + AstrBotInstaller.URL
                        + " · 用户名 " + AstrBotInstaller.username + " · 密码 " + pwdText(), 20000);
            } else if (st == AstrBotInstaller.FAIL) {
                showLogPanel();
                showHint("装 AstrBot 失败：" + AstrBotInstaller.failKind
                        + " · 最后 20 行在日志面板（点「复制」发我）", 20000);
            }
        }
    }

    private String pwdText() {
        return AstrBotInstaller.password.length() > 0
                ? AstrBotInstaller.password
                : "（只在首次启动打印，见 /root/astrbot/data/cmd_config.json）";
    }

    // ───────────────────────── 存储权限（仅 API < 29 需要） ─────────────────────────

    private boolean hasStoragePerm() {
        if (Build.VERSION.SDK_INT >= 29) return true;
        if (Build.VERSION.SDK_INT < 23) return true;
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestStorage() {
        if (Build.VERSION.SDK_INT < 23) return;
        if (Build.VERSION.SDK_INT >= 29) return;
        try {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            showHint("请允许存储权限（写下载/相册要用）", 5000);
        } catch (Throwable t) {
            showHint("申请存储权限失败：" + t.getMessage(), 6000);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_STORAGE) return;
        int action = pendingAction;
        pendingAction = PENDING_NONE;
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            showHint("没有存储权限：请在系统设置里给「QQ 桥接」打开存储权限", 9000);
            return;
        }
        if (action == PENDING_SAVE) saveToGallery();
        else if (action == PENDING_SHARE) shareQr();
        else if (action == PENDING_EXPORT) exportImage();
    }

    private static void copyTo(File src, OutputStream os) throws IOException {
        InputStream in = new FileInputStream(src);
        try {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
            try { if (os != null) os.close(); } catch (Throwable ignored) { }
        }
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }

    /** 每 500ms 刷一次界面：阶段 + 最近 20 行；端口通了自动切 WebView */
    private void poll() {
        if (polling) return;
        polling = true;
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                // 二维码优先：NapCat 每 2 分钟换一张，文件一变就换图
                try {
                    File png = BridgeService.qrPng();
                    if (png != null && png.exists()) {
                        long stamp = png.lastModified();
                        if (stamp != qrStamp) {
                            qrStamp = stamp;
                            if (qrView == null) {
                                qrView = new ImageView(MainActivity.this);
                                qrView.setAdjustViewBounds(true);
                                content.addView(qrView, new FrameLayout.LayoutParams(
                                        ViewGroup.LayoutParams.MATCH_PARENT,
                                        ViewGroup.LayoutParams.WRAP_CONTENT));
                            }
                            qrView.setImageBitmap(BitmapFactory.decodeFile(png.getAbsolutePath()));
                            qrView.setVisibility(View.VISIBLE);
                            logPanel.setVisibility(View.GONE);
                            // 新二维码 = 旧链接作废，重新抓一次
                            loginUrl = null;
                        }
                        onQrTick(png);
                    }
                } catch (Throwable ignored) { }

                String st = BridgeService.stage();
                String fail = BridgeService.failReason();
                String line = st + (BridgeService.nodeRunning() ? "（node 在跑）" : "");
                if (fail != null && fail.length() > 0) line = st + " · " + fail;
                line = line + "  " + seconds + "s";
                stageText.setText(line);

                String[] tail = BridgeService.tail(20);
                StringBuilder sb = new StringBuilder();
                for (String t : tail) sb.append(t).append('\n');
                if (sb.length() == 0) sb.append("（还没有输出，服务可能还没起来）");
                logText.setText(sb.toString());
                logPanel.post(new Runnable() {
                    @Override public void run() { logPanel.fullScroll(View.FOCUS_DOWN); }
                });
                expireHint();
                tickExport();
                tickAstrBot();

                boolean up = probe(CONSOLE_PORT);
                if (up && !webLoaded) {
                    webLoaded = true;
                    web.loadUrl("http://127.0.0.1:" + CONSOLE_PORT + "/");
                    web.setVisibility(View.VISIBLE);
                    logPanel.setVisibility(View.GONE);
                    toggleBtn.setText("界面");
                    stageText.setText("已连接 · 3100");
                } else if (!up && seconds > TIMEOUT_SECONDS) {
                    // 有明确失败原因时不要盖成"超时"——那会把真正的原因藏起来
                    if (fail == null || fail.length() == 0) {
                        stageText.setText("超时 " + TIMEOUT_SECONDS + "s：3100 没监听 · 点「复制」把日志发我");
                    }
                }
                seconds += 1;
                polling = false;
                poll();
            }
        }, 500);
    }

    private static boolean probe(int port) {
        java.net.Socket s = new java.net.Socket();
        try {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 400);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        polling = false;
        if (ui != null) ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
