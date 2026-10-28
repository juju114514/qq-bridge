FROM node:22-bookworm-slim

# 只装官方通道需要的东西：桥接本体 + ffmpeg（视频/语音转码）。
# 本地注入（个人号 SnowLuma）需要扫码登录，官方建议在宿主机跑，见 docker-compose.yml 注释。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# 依赖先装，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

# 源码
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY config.example.json verify.ps1 README.md LICENSE* ./
COPY plugins ./plugins

# state 挂 volume；首次启动会把 config.example.json 复制成 config.json
RUN mkdir -p /app/state && cp /app/config.example.json /app/config.json

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3100/api/status >/dev/null || exit 1

CMD ["node", "src/bridge.js"]
