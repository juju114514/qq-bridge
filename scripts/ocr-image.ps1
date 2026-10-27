#Requires -Version 5.1
<#
.SYNOPSIS
  用 Windows 自带 OCR（Windows.Media.Ocr）识别一张图片里的文字，结果写成 JSON。

.DESCRIPTION
  ============================ 契约（给接手的 AI 看） ============================
  输入：一张本地图片文件（PNG/JPEG/BMP/TIFF；桥接会先把 QQ 图落盘再调本脚本）
  输出：**只走文件**，不往 stdout 打印结果。原因见 voice-core.js / media-normalize.js
        的注释：受限沙箱下 `spawn` + stdio:'pipe' 会直接 EPERM，所以统一用
        「临时文件 + --Out」做进程间通信。
        JSON 形状：
          成功 { ok:true, lang:"zh-Hans-CN", ms:123, width, height, lines:[{text,x,y,w,h}], text:"按行拼接" }
          失败 { ok:false, error:"...", reason:"no-ocr | no-lang | bad-image | winrt-missing | timeout" }

  为什么要它：群里那条建议「要是只想知道写了什么，先 OCR 出文字给我更省；看图才需要切片」——
  一张 1080×6000 的长截图，切成 5 片要给模型 5 张图（~1.7MB / 约 1.5 万 token），
  而 OCR 出文字只要几百 token。所以长图默认先走 OCR，看不清才退回切片。

  为什么用 Windows 自带而不是 PaddleOCR：
    · 零依赖、离线、不需要再装 Python 侧常驻服务
    · 简中识别在聊天截图上够用（实测见 docs 的样本）
    · 代价：只 Windows；Linux 上本脚本不存在，桥接会自动退回切片（不报错）

  退出码：0 成功（哪怕识别出 0 行，也是 ok:true + text:""）；1 失败（JSON 里带 reason）
#>
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Out,
  # 识别语言标签；空=按用户配置语言（一般就是中文）
  [string]$Lang = ''
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  try {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function Fail($reason, $message) {
  Write-Result @{ ok = $false; reason = $reason; error = $message }
  exit 1
}

if (-not (Test-Path -LiteralPath $Image)) { Fail 'bad-image' "找不到图片：$Image" }

# ── WinRT 装配 ────────────────────────────────────────────────────────────
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
} catch {
  Fail 'winrt-missing' "WinRT 类型加载失败（系统太旧或 PowerShell 受限）：$($_.Exception.Message)"
}

# IAsyncOperation<T> → .NET Task 的等待器（PowerShell 5.1 没有 await）
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
if (-not $asTaskGeneric) { Fail 'winrt-missing' '找不到 AsTask 泛型方法，无法等待 WinRT 异步操作' }

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($operation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# ── 选引擎 ───────────────────────────────────────────────────────────────
try {
  $engine = $null
  if ($Lang) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans')) }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
  if (-not $engine) {
    $available = ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', '
    Fail 'no-lang' "系统没有可用的 OCR 语言包（已装：$available）。设置 → 时间和语言 → 语言 → 添加语言包（带基本键入/OCR）"
  }
} catch {
  Fail 'no-lang' "创建 OCR 引擎失败：$($_.Exception.Message)"
}

# ── 解码 + 识别 ──────────────────────────────────────────────────────────
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Image).Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
  Fail 'bad-image' "解码或识别失败：$($_.Exception.Message)"
} finally {
  if ($stream) { try { $stream.Dispose() } catch { } }
  if ($bitmap) { try { $bitmap.Dispose() } catch { } }
}

$sw.Stop()
$lines = @()
foreach ($line in $result.Lines) {
  $first = $line.Words | Select-Object -First 1
  $lines += @{
    text = $line.Text
    x = if ($first) { [int]$first.BoundingRect.X } else { 0 }
    y = if ($first) { [int]$first.BoundingRect.Y } else { 0 }
    w = if ($first) { [int]$first.BoundingRect.Width } else { 0 }
    h = if ($first) { [int]$first.BoundingRect.Height } else { 0 }
  }
}

Write-Result ([ordered]@{
    ok     = $true
    lang   = $engine.RecognizerLanguage.LanguageTag
    ms     = [int]$sw.ElapsedMilliseconds
    width  = [int]$decoder.PixelWidth
    height = [int]$decoder.PixelHeight
    lines  = $lines
    text   = (($lines | ForEach-Object { $_.text }) -join "`n")
  })
exit 0
