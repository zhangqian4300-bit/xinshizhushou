/**
 * 配置管理模块
 * 统一加载和验证环境变量
 */

import dotenv from 'dotenv';

// 加载 .env 文件（仅在非生产环境）
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// 配置对象
export const config = {
  // 服务配置
  port: parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // MongoDB 配置
  mongodbUri: process.env.MONGODB_URI || null,

  // OpenClaw Gateway 配置
  openclaw: {
    port: process.env.OPENCLAW_GATEWAY_PORT ? parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10) : null,
    url: process.env.OPENCLAW_GATEWAY_URL || null,
    host: process.env.OPENCLAW_GATEWAY_HOST || null
  },

  // 安全配置
  security: {
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : null,
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10)
    }
  },

  // 日志配置
  logLevel: process.env.LOG_LEVEL || 'info'
};

/**
 * 验证生产环境必需配置
 */
export function validateProductionConfig() {
  const errors = [];

  if (!config.mongodbUri) {
    errors.push('MONGODB_URI is required for production');
  }

  if (!config.security.allowedOrigins) {
    errors.push('ALLOWED_ORIGINS is required for production');
  }

  if (errors.length > 0) {
    console.error('[Config] Missing required production config:');
    errors.forEach(err => console.error(`  - ${err}`));
    throw new Error('Invalid production configuration');
  }

  return true;
}

/**
 * 检查是否使用 MongoDB
 */
export function useMongoDB() {
  return config.nodeEnv === 'production' || config.mongodbUri;
}