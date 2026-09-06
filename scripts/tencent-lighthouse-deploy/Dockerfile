# CRM-ai-native 应用镜像
# 基于 Node 22（与本地开发栈一致）
FROM node:22-bookworm-slim

# 国内 npm 加速（可覆盖：docker compose build --build-arg NPM_REGISTRY=...）
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

# 仅先拷 package.json，利用层缓存
COPY package.json package-lock.json* ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install --omit=dev \
 && npm config delete registry

# 拷贝全部源码（node_modules / .git / .workbuddy 等由 .dockerignore 排除）
COPY . .

# 附件存储目录（src/assets/storage.js 默认写 ../../uploads/assets；缺失会导致上传 500）
RUN mkdir -p /app/uploads/assets

EXPOSE 3000
# 实际启动命令在 docker-compose.yml 的 command 中指定：
#   node db/migrate.js && node src/http/server.js
