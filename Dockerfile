# 心石清理师 Agent Dockerfile
# Node.js 18 LTS

FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制源代码
COPY src/ ./src/
COPY examples/ ./examples/
COPY public/ ./public/
COPY prompts/ ./prompts/

# 创建非 root 用户
RUN addgroup -g 1000 -S appgroup && \
    adduser -u 1000 -S appuser -G appgroup

# 数据目录（可选，用于 JSON 文件存储）
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

# 环境变量
ENV NODE_ENV=production
ENV SERVER_PORT=3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "examples/xinshi-agent.js"]