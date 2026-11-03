# -*- coding: utf-8 -*-
"""抓 Termux 的 node 运行库（aarch64）到 D:\QQBot\tools\arm64\termux-libs。

为什么需要：手机上私有目录里的 node 是 Termux 构建的 bionic 二进制，NEEDED 里写着
libz.so.1 / libcares.so / libsqlite3.so / libcrypto.so.3 / libssl.so.3 / libicu*.so.78 /
libc++_shared.so，这些 Android 系统里没有，必须自带。
"""
import gzip, lzma, os, shutil, struct, sys, tarfile, urllib.request

BASE = "https://packages.termux.dev/apt/termux-main"
OUT = r"D:\QQBot\tools\arm64\termux-libs"
WANT = ["zlib", "c-ares", "libsqlite", "openssl", "libicu", "libc++"]
SYSTEM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
               "libstdc++.so", "libz.so", "libnativehelper.so", "libnativewindow.so",
               "libvulkan.so", "libEGL.so", "libGLESv2.so", "libsync.so", "libui.so",
               "libbase.so", "libc++_shared.so"}  # 最后这个我们自带

def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()

def parse_index():
    text = gzip.decompress(fetch(BASE + "/dists/stable/main/binary-aarch64/Packages.gz")).decode("utf-8", "replace")
    out = {}
    for stanza in text.split("\n\n"):
        d = {}
        for line in stanza.splitlines():
            if ": " in line:
                k, v = line.split(": ", 1)
                d[k] = v
        if d.get("Package") in WANT:
            out[d["Package"]] = d
    return out

def ar_members(blob):
    assert blob[:8] == b"!<arch>\n", "not an ar archive"
    off = 8
    while off + 60 <= len(blob):
        hdr = blob[off:off + 60]
        name = hdr[0:16].decode().strip()
        size = int(hdr[48:58].decode().strip())
        data = blob[off + 60: off + 60 + size]
        yield name, data
        off += 60 + size + (size % 2)

def extract_deb(blob, dest):
    got = []
    for name, data in ar_members(blob):
        if not name.startswith("data.tar"):
            continue
        if name.endswith(".xz"):
            raw = lzma.decompress(data)
        elif name.endswith(".gz"):
            raw = gzip.decompress(data)
        elif name.endswith(".zst"):
            import zstandard  # noqa: 只在 Termux 换压缩时才会用到
            raw = zstandard.ZstdDecompressor().decompress(data)
        else:
            raw = data
        import io
        symlinks = []
        with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
            for m in tf.getmembers():
                base = os.path.basename(m.name)
                if "/usr/lib/" not in m.name or not base:
                    continue
                if not (base.endswith(".so") or ".so." in base):
                    continue
                target = os.path.join(dest, base)
                if m.issym():
                    symlinks.append((base, os.path.basename(m.linkname)))
                elif m.isfile():
                    src = tf.extractfile(m)
                    if src is None:
                        continue
                    with open(target, "wb") as dst:
                        dst.write(src.read())
                    os.chmod(target, 0o755)
                    got.append(base)
        # 软链在 Android 上没必要保留，直接做成实体副本（loader 只认文件）
        for base, linkname in symlinks:
            src = os.path.join(dest, linkname)
            if not os.path.exists(src):
                raise SystemExit("软链目标还没解出来: %s -> %s" % (base, linkname))
            shutil.copyfile(src, os.path.join(dest, base))
            os.chmod(os.path.join(dest, base), 0o755)
            got.append(base)
    return got

def needed(path):
    with open(path, "rb") as f:
        buf = f.read()
    if buf[:4] != b"\x7fELF" or buf[4] != 2:
        return []
    dyn_off = dyn_size = None
    phoff = struct.unpack_from("<Q", buf, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", buf, 54)
    for i in range(phnum):
        p = phoff + i * phentsize
        if struct.unpack_from("<I", buf, p)[0] == 2:
            dyn_off = struct.unpack_from("<Q", buf, p + 8)[0]
            dyn_size = struct.unpack_from("<Q", buf, p + 32)[0]
    if dyn_off is None:
        return []
    entries = []
    off = dyn_off
    strtab = None
    while off < dyn_off + dyn_size:
        tag, val = struct.unpack_from("<qQ", buf, off)
        entries.append((tag, val))
        if tag == 0:
            break
        off += 16
    strtab = next(v for t, v in entries if t == 5)
    def cstr(o):
        end = buf.index(b"\x00", o)
        return buf[o:end].decode()
    return [cstr(strtab + v) for t, v in entries if t == 1]

def main():
    STAGE = OUT + "-stage"
    for d in (STAGE, OUT):
        if os.path.isdir(d):
            shutil.rmtree(d)
    os.makedirs(STAGE, exist_ok=True)
    idx = parse_index()
    for pkg in WANT:
        d = idx.get(pkg)
        if not d:
            print("MISSING", pkg); sys.exit(2)
        url = BASE + "/" + d["Filename"]
        print("downloading", pkg, d["Version"], d["Size"], "bytes")
        got = extract_deb(fetch(url), STAGE)
        print("   ->", len(got), "个 .so")

    # 只留 node 真正要的（含递归依赖）：ICU 的 io/test/tu 这类几十兆没人用
    node = r"D:\QQBot\tools\arm64\extract\bin\node"
    keep, queue, seen, unresolved = set(), [node], set(), set()
    while queue:
        f = queue.pop()
        if f in seen:
            continue
        seen.add(f)
        for n in needed(f):
            if n in keep:
                continue
            cand = os.path.join(STAGE, n)
            if os.path.exists(cand):
                keep.add(n)
                queue.append(cand)
            elif n not in SYSTEM_LIBS:
                unresolved.add(n)

    os.makedirs(OUT, exist_ok=True)
    for n in sorted(keep):
        shutil.copyfile(os.path.join(STAGE, n), os.path.join(OUT, n))
        os.chmod(os.path.join(OUT, n), 0o755)
    shutil.rmtree(STAGE, ignore_errors=True)

    print("\n=== 结果 ===")
    for n in sorted(keep):
        print("  %-22s %6.1f MB" % (n, os.path.getsize(os.path.join(OUT, n)) / 1048576))
    if unresolved:
        print("缺少:", ", ".join(sorted(unresolved)))
    else:
        print("OK：node 与全部 .so 的 NEEDED 都能被满足")
    print("libs:", len(keep), "total MB:", round(sum(os.path.getsize(os.path.join(OUT, x)) for x in keep) / 1048576, 1))

main()
