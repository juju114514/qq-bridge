"""一键流水线：刷一轮 → 补互动数据 → 语义判断

调用三个脚本，串行执行，日志直接打到 stdout（服务端会把它写进 douyin/pipeline.log）。

用法：
  python douyin_pipeline.py --pages 2 --top 5
"""
import argparse
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))


def run(script: str, args: list) -> int:
    cmd = [sys.executable, "-u", os.path.join(ROOT, script)] + args
    print(f"\n=== {script} {' '.join(args)} ===", flush=True)
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT)
    print(f"--- {script} 退出码 {p.returncode}，用时 {int(time.time() - t0)} 秒 ---", flush=True)
    return p.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=2)
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    t0 = time.time()
    rc1 = run("douyin_browse.py", ["--pages", str(args.pages)])
    if rc1 != 0:
        print("[流水线] 刷取失败，停在这里")
        return
    rc2 = run("douyin_enrich.py", ["--top", str(args.top)])
    if rc2 != 0:
        print("[流水线] 补数据失败，继续判断已有的")
    rc3 = run("douyin_judge.py", ["--top", str(args.top)])
    print(f"\n[流水线] 全部完成，总用时 {int(time.time() - t0)} 秒")


if __name__ == "__main__":
    main()
