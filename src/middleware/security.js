/**
 * 安全中间件
 * CORS 配置 + Rate Limiting
 */

import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

/**
 * CORS 中间件
 */
export function corsMiddleware() {
  const options = {
    origin: config.security.allowedOrigins || true, // 开发环境允许所有来源
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
    maxAge: 86400 // 24小时
  };

  return cors(options);
}

/**
 * Rate Limit 中间件
 * 防止 API 滥用
 */
export function rateLimitMiddleware() {
  return rateLimit({
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.maxRequests,
    message: {
      error: '请求过于频繁，请稍后再试',
      code: 'RATE_LIMIT_EXCEEDED'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // 跳过健康检查等路径
    skip: (req) => {
      return req.path === '/health' || req.path === '/assess/questions';
    }
  });
}

/**
 * 请求验证中间件
 * 验证必需字段
 */
export function validateRequest(requiredFields) {
  return (req, res, next) => {
    const missing = requiredFields.filter(f => !req.body[f]);
    if (missing.length > 0) {
      return res.status(400).json({
        error: `缺少必需字段: ${missing.join(', ')}`,
        code: 'INVALID_REQUEST'
      });
    }
    next();
  };
}

/**
 * 错误处理中间件
 */
export function errorHandler(err, req, res, next) {
  console.error('[Error]', err);

  // 区分错误类型
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: err.message,
      code: 'VALIDATION_ERROR'
    });
  }

  if (err.name === 'MongoError' || err.name === 'MongooseError') {
    return res.status(503).json({
      error: '数据库服务暂时不可用',
      code: 'DATABASE_ERROR'
    });
  }

  // 默认服务器错误
  res.status(500).json({
    error: config.nodeEnv === 'production' ? '服务器内部错误' : err.message,
    code: 'INTERNAL_ERROR'
  });
}