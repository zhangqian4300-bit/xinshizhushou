/**
 * 结构化日志模块
 * 开发环境：彩色文本输出
 * 生产环境：JSON 格式输出（便于日志收集）
 */

import { config } from '../config.js';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const COLORS = {
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m'
};

class Logger {
  constructor(context = 'App') {
    this.context = context;
    this.minLevel = LOG_LEVELS[config.logLevel] || LOG_LEVELS.info;
  }

  _formatTime() {
    return new Date().toISOString();
  }

  _log(level, message, data = {}) {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const timestamp = this._formatTime();

    if (config.nodeEnv === 'production') {
      // 生产环境：JSON 格式
      console.log(JSON.stringify({
        timestamp,
        level,
        context: this.context,
        message,
        ...data
      }));
    } else {
      // 开发环境：彩色文本
      const color = COLORS[level];
      const prefix = `${color}[${level.toUpperCase()}]${COLORS.reset} [${this.context}]`;
      console.log(`${prefix} ${message}`);
      if (Object.keys(data).length > 0) {
        console.log(data);
      }
    }
  }

  debug(message, data = {}) {
    this._log('debug', message, data);
  }

  info(message, data = {}) {
    this._log('info', message, data);
  }

  warn(message, data = {}) {
    this._log('warn', message, data);
  }

  error(message, data = {}) {
    this._log('error', message, data);
  }

  // 创建子 logger
  child(context) {
    return new Logger(`${this.context}:${context}`);
  }
}

// 导出默认 logger
export const logger = new Logger('Xinshi');

// 导出工厂函数
export function createLogger(context) {
  return new Logger(context);
}