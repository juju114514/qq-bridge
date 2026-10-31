// qq-bridge 小应用（GUI，0.4.83）
//
// 用户："做成一个小应用那样的，有很多按钮，每个按键代表一个指令"；名字叫「排错程序」——
// 因为这 12 个按钮干的就是排错：体检、看日志、自检、查更新、扫码、停止。
// 布局修正（0.4.83.1）：标题与路径原来用绝对定位 + 不换行，路径一长就压到按钮上。
// 现在改成 Dock 布局 + 单行省略号（AutoEllipsis），窗口缩放也不会再串格。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class LauncherGui
{
    static string root;
    static string node;
    static TextBox output;
    static Label status;
    static List<Button> buttons = new List<Button>();

    [STAThread]
    static void Main(string[] args)
    {
        try { root = FindRepoRoot(AppDomain.CurrentDomain.BaseDirectory); } catch { root = AppDomain.CurrentDomain.BaseDirectory; }
        node = FindNode();

        var form = new Form();
        form.Text = "QQ 桥接 · 排错程序";
        form.Size = new Size(780, 640);
        form.MinimumSize = new Size(680, 520);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(24, 32, 48);
        form.ForeColor = Color.Gainsboro;
        form.Font = new Font("Microsoft YaHei UI", 9f);

        // 布局：**不用 Dock**（WinForms 的 Dock 是按反向 z-order 摆的，很容易把标题挤到按钮下面）。
        // 全部改成绝对定位 + 右边 Anchor，宽度按窗口算；超长文本用 AutoEllipsis 省略。
        int w = form.ClientSize.Width - 28;

        var title = new Label();
        title.Text = "QQ ↔ DeepSeek Harness";
        title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(180, 210, 255);
        title.AutoSize = false;
        title.TextAlign = ContentAlignment.MiddleLeft;
        title.SetBounds(14, 10, w, 28);
        title.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        form.Controls.Add(title);

        var info = new Label();
        string nodeShort = node == null ? "⚠ 未找到 node" : "node 已就绪";
        info.Text = "仓库 " + SafeName(root) + "   ·   " + nodeShort;
        info.Font = new Font("Microsoft YaHei UI", 8.5f);
        info.ForeColor = Color.FromArgb(150, 165, 190);
        info.AutoSize = false;
        info.AutoEllipsis = true;
        info.TextAlign = ContentAlignment.MiddleLeft;
        info.SetBounds(16, 38, w, 18);
        info.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        form.Controls.Add(info);

        var tips = new ToolTip();
        tips.SetToolTip(title, "仓库：" + root + "\nnode：" + (node ?? "(未找到)"));
        tips.SetToolTip(info, "仓库：" + root + "\nnode：" + (node ?? "(未找到)"));

        // ── 按钮区：4 列 × 3 行（每个 = 一条命令）────────────────────────
        var grid = new TableLayoutPanel();
        grid.SetBounds(14, 62, w, 172);
        grid.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        grid.ColumnCount = 4;
        grid.RowCount = 3;
        for (int c = 0; c < 4; c++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        for (int r = 0; r < 3; r++) grid.RowStyles.Add(new RowStyle(SizeType.Percent, 33.3f));
        form.Controls.Add(grid);

        AddButton(grid, 0, 0, "① 体检", "快速自检：Node / 配置 / 网关 / 桥接", () => RunNode("scripts\\launcher.mjs", "--check"));
        AddButton(grid, 1, 0, "② 一键拉起", "拉起网关 + 桥接（start-all.ps1）", () => RunPs("scripts\\start-all.ps1"));
        AddButton(grid, 2, 0, "③ 打开控制台", "浏览器打开工作台", () => OpenUrl("http://127.0.0.1:" + ConsolePort() + "/"));
        AddButton(grid, 3, 0, "④ 网关扫码页", "打开 SnowLuma 的 5099", () => OpenUrl("http://127.0.0.1:5099/"));

        AddButton(grid, 0, 1, "⑤ 看日志", "state/bridge.log 末尾 20 行", TailLog);
        AddButton(grid, 1, 1, "⑥ 跑 18 项自检", "verify-qq-bridge.ps1", () => RunPs("scripts\\verify-qq-bridge.ps1"));
        AddButton(grid, 2, 1, "⑦ 检查更新", "对比 GitHub 最新 release（不改文件）", () => RunNode("scripts\\update.mjs", "--check"));
        AddButton(grid, 3, 1, "⑧ 停止", "结束计划任务 qq-bridge", () => RunPsInline("schtasks /end /tn qq-bridge"));

        AddButton(grid, 0, 2, "⑨ 建快捷方式", "桌面 + 开始菜单", () => RunPs("scripts\\make-shortcut.ps1"));
        AddButton(grid, 1, 2, "⑩ 打开仓库目录", "资源管理器", () => Process.Start("explorer.exe", "\"" + root + "\""));
        AddButton(grid, 2, 2, "⑪ 运行报告", "打开控制台 → 运行报告", () => OpenUrl("http://127.0.0.1:" + ConsolePort() + "/#report"));
        AddButton(grid, 3, 2, "⑫ 清空输出", "清空下面的输出", () => { output.Clear(); SetStatus("就绪"); });

        // ── 输出区 ────────────────────────────────────────────────────
        output = new TextBox();
        output.Multiline = true;
        output.ReadOnly = true;
        output.ScrollBars = ScrollBars.Both;
        output.WordWrap = false;
        output.Font = new Font("Consolas", 9f);
        output.BackColor = Color.FromArgb(12, 18, 28);
        output.ForeColor = Color.FromArgb(210, 226, 255);
        output.BorderStyle = BorderStyle.FixedSingle;
        output.SetBounds(14, 240, w, form.ClientSize.Height - 300);
        output.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        form.Controls.Add(output);

        // ── 底部状态条 ────────────────────────────────────────────────
        status = new Label();
        status.Text = "就绪 —— 点上面任意按钮";
        status.Font = new Font("Microsoft YaHei UI", 9f);
        status.ForeColor = Color.FromArgb(160, 200, 245);
        status.AutoSize = false;
        status.AutoEllipsis = true;
        status.TextAlign = ContentAlignment.MiddleLeft;
        status.SetBounds(16, form.ClientSize.Height - 32, w - 90, 22);
        status.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        form.Controls.Add(status);

        var quit = new Button();
        quit.Text = "退出";
        quit.SetBounds(form.ClientSize.Width - 90, form.ClientSize.Height - 34, 76, 26);
        quit.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        quit.FlatStyle = FlatStyle.Flat;
        quit.FlatAppearance.BorderColor = Color.FromArgb(70, 90, 120);
        quit.ForeColor = Color.Gainsboro;
        quit.Click += (s, e) => form.Close();
        form.Controls.Add(quit);

        if (node == null)
        {
            Append("⚠ 没找到 node，按钮点了也跑不起来。");
            Append("  1) 装 Node 22+   2) 设环境变量 QQB_NODE 指向 node.exe");
            Append("  3) 本机 DSH 自带的那份在 %USERPROFILE%\\.dsh\\dsh-runtimes\\...\\node\\bin\\node.exe");
        }
        else
        {
            Append("就绪。点上面任意按钮，输出会显示在这里。");
        }

        Application.Run(form);
    }

    static string SafeName(string path)
    {
        try { return new DirectoryInfo(path).Name; } catch { return path; }
    }

    static void AddButton(TableLayoutPanel grid, int col, int row, string text, string tip, Action onClick)
    {
        var b = new Button();
        b.Text = text;
        b.Dock = DockStyle.Fill;
        b.Margin = new Padding(4);
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderColor = Color.FromArgb(72, 100, 140);
        b.BackColor = Color.FromArgb(34, 46, 66);
        b.ForeColor = Color.FromArgb(226, 236, 250);
        b.Font = new Font("Microsoft YaHei UI", 9.5f);
        b.AutoEllipsis = true;
        if (!string.IsNullOrEmpty(tip)) { var t = new ToolTip(); t.SetToolTip(b, tip); }
        b.Click += (s, e) => { try { onClick(); } catch (Exception ex) { Append("[X] " + ex.Message); } };
        buttons.Add(b);
        grid.Controls.Add(b, col, row);
    }

    static void SetBusy(bool busy) { foreach (var b in buttons) b.Enabled = !busy; }

    static void SetStatus(string text)
    {
        if (status == null) return;
        if (status.InvokeRequired) { status.BeginInvoke(new Action<string>(SetStatus), text); return; }
        status.Text = text;
    }

    static void Append(string line)
    {
        if (output == null) return;
        if (output.InvokeRequired) { output.BeginInvoke(new Action<string>(Append), line); return; }
        output.AppendText(line + Environment.NewLine);
    }

    static void RunNode(string script, string args)
    {
        if (node == null) { Append("⚠ 没找到 node，跑不了。"); return; }
        StartProcess(node, "\"" + Path.Combine(root, script) + "\" " + args, Path.GetFileName(script) + " " + args);
    }

    static void RunPs(string script)
    {
        StartProcess("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, script) + "\"", Path.GetFileName(script));
    }

    static void RunPsInline(string commandLine) { StartProcess("cmd.exe", "/c " + commandLine, commandLine); }

    static void StartProcess(string file, string arguments, string label)
    {
        SetBusy(true);
        SetStatus("运行中：" + label);
        Append("");
        Append("▶ " + label);
        var sw = Stopwatch.StartNew();
        var psi = new ProcessStartInfo
        {
            FileName = file,
            Arguments = arguments,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (s, e) => { if (e.Data != null) Append(e.Data); };
        p.ErrorDataReceived += (s, e) => { if (e.Data != null) Append("! " + e.Data); };
        p.EnableRaisingEvents = true;
        p.Exited += (s, e) =>
        {
            sw.Stop();
            int code = 0;
            try { code = p.ExitCode; } catch { }
            Append("—— 结束：退出码 " + code + "，用时 " + (sw.ElapsedMilliseconds / 1000.0).ToString("0.0") + "s");
            SetBusy(false);
            SetStatus("就绪（上次：" + label + " → " + code + "）");
        };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
    }

    static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            SetStatus("已打开：" + url);
        }
        catch (Exception e) { Append("[X] 打开失败：" + e.Message); }
    }

    static void TailLog()
    {
        try
        {
            var file = Path.Combine(root, "state", "bridge.log");
            if (!File.Exists(file)) { Append("还没有日志：" + file); return; }
            var lines = File.ReadAllLines(file);
            int from = Math.Max(0, lines.Length - 20);
            Append("");
            Append("▶ 最近 20 行日志");
            for (int i = from; i < lines.Length; i++) Append(lines[i]);
        }
        catch (Exception e) { Append("[X] 读日志失败：" + e.Message); }
    }

    static int ConsolePort()
    {
        try
        {
            var cfg = Path.Combine(root, "config.json");
            if (File.Exists(cfg))
            {
                var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(cfg), "\"consolePort\"\\s*:\\s*(\\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
        }
        catch { }
        return 3100;
    }

    static string FindRepoRoot(string start)
    {
        string dir = start;
        for (int i = 0; i < 5 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "scripts", "launcher.mjs"))) return dir;
            var parent = Directory.GetParent(dir);
            dir = parent == null ? null : parent.FullName;
        }
        return start;
    }

    static string FindNode()
    {
        string env = Environment.GetEnvironmentVariable("QQB_NODE");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        foreach (var part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (string.IsNullOrWhiteSpace(part)) continue;
            try { var c = Path.Combine(part.Trim(), "node.exe"); if (File.Exists(c)) return c; } catch { }
        }
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var up = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var known = new List<string> {
            Path.Combine(pf, "nodejs", "node.exe"),
            Path.Combine(lad, "Programs", "nodejs", "node.exe"),
            Path.Combine(lad, "Programs", "node", "node.exe")
        };
        try
        {
            var rt = Path.Combine(up, ".dsh", "dsh-runtimes");
            if (Directory.Exists(rt))
                foreach (var d in Directory.GetDirectories(rt))
                    known.Add(Path.Combine(d, "dependencies", "node", "bin", "node.exe"));
        }
        catch { }
        foreach (var k in known) { try { if (File.Exists(k)) return k; } catch { } }
        return null;
    }
}
