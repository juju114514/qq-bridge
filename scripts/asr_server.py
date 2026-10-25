"""可选的本地语音转写服务（faster-whisper 常驻，模型只加载一次）。

为什么需要它：QQ 侧的语音转写经常为空，机器人收到的语音只剩一个 `[语音]`。
起这个服务后，桥接会把语音 URL 发过来转成文字，再把文字当成消息内容。

依赖（自己装）：
    pip install faster-whisper pilk
    另需 ffmpeg（非 SILK 格式转码用），放在 PATH 里或用 ASR_FFMPEG 指定

用法：
    python asr_server.py [端口=3111] [模型=small]

接口：
    GET  /health       -> {"ok": true, "model": "small", "loaded": true}
    POST /transcribe   {"url": "https://..."}  或 {"path": "本地路径"}
                       -> {"ok": true, "text": "...", "seconds": 3.1, "via": "silk"}
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

import pilk  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

_CACHE = os.path.join(tempfile.gettempdir(), 'qq-asr-cache')
os.makedirs(_CACHE, exist_ok=True)

MODEL_SIZE = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('ASR_MODEL', 'small')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('ASR_PORT', '3111'))
FFMPEG = os.environ.get('ASR_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'

_model = None
_model_lock = threading.Lock()
_lock = threading.Lock()          # 串行识别，避免并发抢 CPU


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            t0 = time.time()
            _model = WhisperModel(MODEL_SIZE, device='cpu', compute_type='int8')
            print('[asr] 模型已加载 %s（%.1fs）' % (MODEL_SIZE, time.time() - t0), flush=True)
    return _model


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    return urllib.request.urlopen(req, timeout=30).read()


def to_wav(raw, tag):
    wav_path = os.path.join(_CACHE, 'in-%s.wav' % tag)
    idx = raw.find(b'#!SILK_V3')
    if idx < 0:
        idx = raw.find(b'#!SILK')
    if idx >= 0:                      # QQ 语音条
        silk_path = os.path.join(_CACHE, 'in-%s.silk' % tag)
        with open(silk_path, 'wb') as f:
            f.write(raw[idx:])
        pilk.silk_to_wav(silk_path, wav_path, 16000)
        return wav_path, 'silk'
    src_path = os.path.join(_CACHE, 'in-%s.bin' % tag)
    with open(src_path, 'wb') as f:
        f.write(raw)
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', src_path,
                    '-ar', '16000', '-ac', '1', '-f', 'wav', wav_path],
                   check=True, timeout=60)
    return wav_path, 'ffmpeg'


def transcribe(raw, tag):
    wav_path, how = to_wav(raw, tag)
    try:
        with wave.open(wav_path, 'rb') as w:
            seconds = w.getnframes() / float(w.getframerate() or 1)
    except Exception:
        seconds = 0.0
    if seconds < 0.2:
        return {'ok': False, 'error': '音频太短（%.2fs）' % seconds}
    segments, info = get_model().transcribe(
        wav_path, language='zh', beam_size=5, vad_filter=True,
        initial_prompt='以下是普通话的句子，请用简体中文输出。')
    text = ''.join(s.text for s in segments).strip()
    for p in (wav_path, os.path.join(_CACHE, 'in-%s.bin' % tag), os.path.join(_CACHE, 'in-%s.silk' % tag)):
        try:
            os.unlink(p)
        except Exception:
            pass
    return {'ok': True, 'text': text, 'seconds': round(info.duration, 1), 'via': how}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'ok': True, 'model': MODEL_SIZE, 'loaded': _model is not None})
        else:
            self._send(404, {'ok': False})

    def do_POST(self):
        if not self.path.startswith('/transcribe'):
            self._send(404, {'ok': False})
            return
        try:
            n = int(self.headers.get('content-length') or 0)
            data = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            self._send(400, {'ok': False, 'error': 'body 解析失败: %s' % e})
            return
        try:
            if data.get('url'):
                raw = fetch(str(data['url']))
            elif data.get('path'):
                with open(str(data['path']), 'rb') as f:
                    raw = f.read()
            else:
                self._send(400, {'ok': False, 'error': '需要 url 或 path'})
                return
            if not raw:
                self._send(400, {'ok': False, 'error': '音频为空'})
                return
            tag = '%d-%d' % (int(time.time() * 1000), threading.get_ident())
            with _lock:
                result = transcribe(raw, tag)
            self._send(200 if result.get('ok') else 422, result)
        except Exception as e:
            self._send(500, {'ok': False, 'error': str(e)[:200]})


def main():
    try:
        get_model()
    except Exception as e:
        print('[asr] 预热失败（首次识别会再试）：%s' % e, flush=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('[asr] 就绪 http://127.0.0.1:%d （模型 %s）' % (PORT, MODEL_SIZE), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
