# 一体化 APK · 构建脚本（0.5.59 起）
#
# 不需要 Gradle：javac → d8 → aapt2 → 注入 dex → zipalign → apksigner
# 这套流程已经用体检 APK 验证过（真机能装能跑）。
#
# 用法：
#   powershell -File build-apk.ps1                # 只编译 Java 并打一个"空壳"包（不含 node/桥接）
#   powershell -File build-apk.ps1 -WithPayload   # 带上 node + 桥接 + node_modules（payload 约 210MB，出包约 60MB）
#
param(
  [switch]$WithPayload,
  [string]$Out = "D:\QQBot-open\mobile\dist\qq-bridge-app.apk"
)

$ErrorActionPreference = "Stop"
$proj = $PSScriptRoot
$jdk  = "D:\QQBot\tools\jdk\jdk-17.0.20.1+1"
$sdk  = "D:\QQBot\tools\android-sdk"
$bt   = Join-Path $sdk "build-tools\34.0.0"
$plat = Join-Path $sdk "platforms\android-34\android.jar"
$dist = Join-Path $proj "build"
$repo = "D:\QQBot-open\qq-bridge"
$arm  = "D:\QQBot\tools\arm64\extract"

$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"

Write-Host "[1/7] 编译 Java" -ForegroundColor Cyan
if (Test-Path "$dist\classes") { Remove-Item "$dist\classes" -Recurse -Force }
# assets 必须清空：否则 -WithPayload 和空壳模式之间会残留旧的 payload.tar
if (Test-Path "$dist\assets") { Remove-Item "$dist\assets" -Recurse -Force }
New-Item -ItemType Directory -Path "$dist\classes","$dist\assets","$dist\dex" -Force | Out-Null
$src = (Get-ChildItem "$proj\app\src\main\java" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& "$jdk\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $plat -d "$dist\classes" $src
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

Write-Host "[2/7] d8 生成 classes.dex" -ForegroundColor Cyan
$classes = (Get-ChildItem "$dist\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& "$bt\d8.bat" --lib $plat --min-api 21 --output "$dist\dex" $classes
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

Write-Host "[3/7] 准备 assets" -ForegroundColor Cyan
# node（arm64 可执行）
Copy-Item (Join-Path $arm "bin\node") "$dist\assets\node" -Force
# CA 包：Android 的 node 没有系统 CA，不带上所有 HTTPS 都会 UNABLE_TO_GET_ISSUER_CERT_LOCALLY
Copy-Item (Join-Path $arm "cacert.pem") "$dist\assets\cacert.pem" -Force
# 阶段 B：NapCat 启动器源码 + OneBot 配置（随包带，手机不联网拉源码）
Copy-Item (Join-Path $proj "assets\launcher.cpp") "$dist\assets\launcher.cpp" -Force
Copy-Item (Join-Path $proj "assets\onebot11.json") "$dist\assets\onebot11.json" -Force
# 阶段 A：容器（proot + Ubuntu rootfs）。二者都是首次启动才解，解过就打标记跳过
Copy-Item (Join-Path $arm "proot.tar") "$dist\assets\proot.tar" -Force
Copy-Item (Join-Path $arm "ubuntu-base-arm64.tar.gz") "$dist\assets\ubuntu-base-arm64.tar.gz" -Force
if ($WithPayload) {
  # 入口文件单独进 assets：服务里先铺这几个（首启不依赖解包），解 tar 时再覆盖。
  # 名字必须平铺在 assets 根：aapt2 在 Windows 上会把子目录存成 assets/app\src\x（反斜杠），
  # Android 的 AssetManager 只认 /，带反斜杠的条目在真机上就是 FileNotFoundException。
  Copy-Item "$repo\src\bridge.js" "$dist\assets\bridge.js" -Force
  # package.json 只保留运行时必需的字段（name/version/private/type/engines）。
  # 为什么不整份拷：真机冒烟时发现 Node 24.22.2 的 package.json 内部解析器
  # 在「带完整 dependencies 的 4KB 文件」上会报 ERR_INVALID_PACKAGE_CONFIG，
  # 而同一份 JSON 用 JSON.parse 又能解开（在 x86 模拟器跑 arm64 node 时复现）。
  # 运行时不需要 dependencies（node_modules 已经装好），瘦身版 111 字节，稳过。
  $pkg = Get-Content "$repo\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $slim = [ordered]@{
    name    = $pkg.name
    version = $pkg.version
    private = $true
    type    = $(if ($pkg.type) { $pkg.type } else { "module" })
  }
  if ($pkg.engines) { $slim.engines = $pkg.engines }
  $slimJson = ($slim | ConvertTo-Json -Depth 4)
  [IO.File]::WriteAllText("$dist\assets\package.json", $slimJson, (New-Object Text.UTF8Encoding($false)))
  Write-Host ("      package.json 瘦身为 {0} 字节（原 {1} 字节）" -f $slimJson.Length, ((Get-Item "$repo\package.json").Length))
  Copy-Item "$repo\config.example.json" "$dist\assets\config.example.json" -Force
  # 源码 + 依赖先铺到 staging，再整体打成一个 tar（避免几百次 asset 读取）。
  $payload = Join-Path $dist "payload"
  if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
  New-Item -ItemType Directory -Path "$payload\app" -Force | Out-Null
  Copy-Item "$repo\src"    "$payload\app\src"    -Recurse -Force
  Copy-Item "$repo\public" "$payload\app\public" -Recurse -Force
  Copy-Item "$dist\assets\package.json" "$payload\app\package.json" -Force
  Copy-Item "$repo\config.example.json" "$payload\app\config.example.json" -Force
  # node_modules 是 pnpm 的链接农场（637 个软链 + 三万硬链）。Android 的 toybox tar
  # 解不了超过 100 字节的链接目标（会变成 ././@LongSymLink 死链），也不认 pax linkpath；
  # Windows 自带的 bsdtar 只写得出 ustar/pax，写不出 GNU longlink。
  # 所以这里用 Copy-Item 把链接实体化（26MB → 约 210MB），换"解出来就是对的"。
  # 想瘦身就得在 Linux/macOS 上打包（那边的 tar 能保留软链），别在这台机器上绕。
  if (Test-Path "$repo\node_modules") {
    Copy-Item "$repo\node_modules" "$payload\app\node_modules" -Recurse -Force
  } else {
    Write-Host "      警告：仓库里没有 node_modules，包里将跑不起来" -ForegroundColor Yellow
  }
  $payloadTar = "$dist\assets\payload.tar"
  & tar.exe -cf $payloadTar -C "$payload\app" "."
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败" }
  $mb = (Get-Item $payloadTar).Length / 1MB
  if ($mb -lt 100) { Write-Host ("      警告：payload 只有 {0:N0} MB，链接可能没实体化" -f $mb) -ForegroundColor Yellow }
  Write-Host ("      payload.tar {0:N1} MB" -f $mb)

  # node 是 Termux 构建的 bionic 二进制，needed 里有 libz.so.1 / libcares / libsqlite3 /
  # libcrypto / libssl / libicu* — Android 系统里没有，必须自带（用 tools/fetch-node-libs.py 抓）。
  $libs = "D:\QQBot\tools\arm64\termux-libs"
  if (-not (Test-Path $libs)) { throw "缺 $libs，先跑：python mobile\apk\tools\fetch-node-libs.py" }
  & tar.exe -cf "$dist\assets\libs.tar" -C $libs "."
  if ($LASTEXITCODE -ne 0) { throw "libs.tar 打包失败" }
  Write-Host ("      libs.tar   {0:N1} MB" -f ((Get-Item "$dist\assets\libs.tar").Length / 1MB))
} else {
  Write-Host "      跳过 payload（-WithPayload 才带 node_modules 与源码）" -ForegroundColor Yellow
}

Write-Host "[4/7] aapt2 link（targetSdk 28！exec 才不被拦）" -ForegroundColor Cyan
& "$bt\aapt2.exe" link -o "$dist\base.apk" -I $plat --manifest "$proj\app\src\main\AndroidManifest.xml" `
  -A "$dist\assets" --min-sdk-version 21 --target-sdk-version 28
if ($LASTEXITCODE -ne 0) { throw "aapt2 失败" }

Write-Host "[5/7] 注入 classes.dex + zipalign" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$dist\base.apk", 'Update')
$e = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::NoCompression)
$st = $e.Open(); $bytes = [IO.File]::ReadAllBytes("$dist\dex\classes.dex"); $st.Write($bytes,0,$bytes.Length); $st.Close()
$zip.Dispose()
& "$bt\zipalign.exe" -f 4 "$dist\base.apk" "$dist\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

Write-Host "[6/7] 签名" -ForegroundColor Cyan
$ks = Join-Path $proj "build\app.keystore"
if (-not (Test-Path $ks)) {
  & "$jdk\bin\keytool.exe" -genkeypair -keystore $ks -alias app -keyalg RSA -keysize 2048 `
    -validity 10000 -storepass app123 -keypass app123 `
    -dname "CN=qqbridge, OU=dev, O=qqbridge, C=CN" | Out-Null
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:app123 --key-pass pass:app123 --out $Out "$dist\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "签名失败" }

Write-Host "[7/7] 校验 assets 名（反斜杠 / 缺件都会让真机首启直接挂）" -ForegroundColor Cyan
$az = [System.IO.Compression.ZipFile]::OpenRead($Out)
$bad = $az.Entries | Where-Object { $_.FullName.Contains('\') }
$names = @($az.Entries | ForEach-Object { $_.FullName })
$az.Dispose()
if ($bad) {
  $badNames = ($bad | ForEach-Object { $_.FullName }) -join ", "
  throw "APK 里有反斜杠条目（AssetManager 打不开）：$badNames"
}
$required = @('assets/node', 'assets/cacert.pem', 'assets/bridge.js', 'assets/package.json', 'classes.dex')
if ($WithPayload) { $required += @('assets/payload.tar', 'assets/libs.tar') }
foreach ($need in $required) {
  if ($names -notcontains $need) { throw "APK 缺少 $need" }
}

Write-Host ""
Write-Host ("完成：{0}  {1:N1} MB" -f $Out, ((Get-Item $Out).Length / 1MB)) -ForegroundColor Green
Write-Host "装：adb install -r `"$Out`"   （或直接传到手机点开）"
