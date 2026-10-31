// qq-bridge 启动器（原生 exe，0.4.83）
//
// 为什么要有它：.cmd 双击后一闪、中文乱码、还得先找 node —— 用户说"指令很不方便"。
// 这个 exe 只做一件事：**找到 node，然后把游戏交回给 scripts/launcher.mjs**。
//   · 所有业务逻辑仍在 JS 里（改逻辑不用重新编译）
//   · 这里只负责：找 node（四级）→ 设置控制台编码 → 启动 → 退出码透传
//
// 编译（本机 .NET Framework 自带 csc，不装任何东西）：
//   csc.exe /nologo /target:exe /out:启动器.exe /r:System.dll scripts\launcher-src\Launcher.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Launcher
{
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if (exeDir.EndsWith("\\scripts\\launcher-src", StringComparison.OrdinalIgnoreCase))
        {
            exeDir = Directory.GetParent(Directory.GetParent(exeDir).FullName).FullName;
        }
        string root = FindRepoRoot(exeDir);
        string script = Path.Combine(root, "scripts", "launcher.mjs");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("[X] 找不到 " + script);
            Console.Error.WriteLine("    请把 启动器.exe 放在仓库根目录（和 scripts/ 同级）。");
            Pause();
            return 1;
        }

        string node = FindNode();
        if (node == null)
        {
            Console.WriteLine();
            Console.WriteLine("  [X] 没找到 node。");
            Console.WriteLine();
            Console.WriteLine("      三种办法任选一种：");
            Console.WriteLine("      1. 装 Node 22+：https://nodejs.org/");
            Console.WriteLine("      2. 用 DSH 自带的那份，设环境变量：");
            Console.WriteLine("         setx QQB_NODE \"%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe\"");
            Console.WriteLine("      3. 或者把 node.exe 所在目录加进 PATH");
            Console.WriteLine();
            Pause();
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + script + "\"",
            WorkingDirectory = root,
            UseShellExecute = false
        };
        if (args != null && args.Length > 0)
        {
            foreach (var a in args)
            {
                psi.Arguments += " " + a;
            }
        }

        try
        {
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                int code = p.ExitCode;
                if (code != 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("  (退出码 " + code + ")");
                }
                Pause();
                return code;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[X] 启动失败：" + e.Message);
            Pause();
            return 1;
        }
    }

    // 从 exe 所在目录往上找，直到看见 scripts/launcher.mjs
    static string FindRepoRoot(string start)
    {
        string dir = start;
        for (int i = 0; i < 5 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "scripts", "launcher.mjs"))) return dir;
            dir = Directory.GetParent(dir) == null ? null : Directory.GetParent(dir).FullName;
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
            try
            {
                var candidate = Path.Combine(part.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }

        var known = new List<string>();
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        known.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
        known.Add(Path.Combine(localAppData, "Programs", "nodejs", "node.exe"));
        known.Add(Path.Combine(localAppData, "Programs", "node", "node.exe"));

        // DSH 自带运行时（本机就是这种：node 没进 PATH）
        try
        {
            string runtimes = Path.Combine(profile, ".dsh", "dsh-runtimes");
            if (Directory.Exists(runtimes))
            {
                foreach (var dir in Directory.GetDirectories(runtimes))
                {
                    known.Add(Path.Combine(dir, "dependencies", "node", "bin", "node.exe"));
                    known.Add(Path.Combine(dir, "node", "node.exe"));
                }
            }
        }
        catch { }

        foreach (var k in known)
        {
            try { if (File.Exists(k)) return k; } catch { }
        }
        return null;
    }

    static void Pause()
    {
        if (Console.IsInputRedirected) return;
        Console.WriteLine();
        Console.WriteLine("  按任意键关闭…");
        try { Console.ReadKey(true); } catch { }
    }
}
