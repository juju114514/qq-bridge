package com.qqbridge.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.graphics.BitmapFactory;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 一体化 APK 的入口：起前台服务 → 等桥接端口通 → 用 WebView 打开控制台。
 *
 * 诊断版（0.5.60）的两条硬规则：
 *   1. **界面上永远有字**：顶部工具条 + 可切换的日志面板，WebView 只在端口通之后才显示。
 *      之前 WebView 和提示各占一半（都 weight=1），结果 WebView 白底盖住文字，用户看到白屏 5 分钟。
 *   2. **失败要说人话**：解压失败 / node 退出 / 120 秒没监听，分别给不同提示，并且能一键复制日志
 *      （手机没有 adb 时，这是唯一的取证方式）。
 */
public class MainActivity extends Activity {

    private static final int CONSOLE_PORT = 3100;
    private static final int TIMEOUT_SECONDS = 180;

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
                cm.setPrimaryClip(ClipData.newPlainText("qqb-diag", BridgeService.dump()));
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

        startBridge();
        poll();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
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

    /** 每 500ms 刷一次界面：阶段 + 最近 20 行；端口通了自动切 WebView */
    private void poll() {
        if (polling) return;
        polling = true;
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                // 二维码优先：NapCat 每 2 分钟换一张，文件一变就换图
                try {
                    java.io.File png = BridgeService.qrPng();
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
                        }
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
