import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// 常见 Gateway 端口列表（用于自动检测）
// 优先检测配置文件中的端口
const COMMON_PORTS = [19000, 18789, 8080, 9000, 19001];

/**
 * 生成 UUID v4
 */
function randomUUID() {
  return crypto.randomUUID();
}

/**
 * 解析 state 目录路径
 */
function resolveStateDir() {
  return join(homedir(), '.openclaw');
}

/**
 * 解析设备身份文件路径
 */
function resolveIdentityPath() {
  return join(resolveStateDir(), 'identity', 'device.json');
}

/**
 * Base64 URL 编码
 */
function base64UrlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * 从 PEM 格式提取原始公钥
 */
function derivePublicKeyRaw(pem) {
  const key = crypto.createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' });
  // ED25519 SPKI 前缀: 302a300506032b6570032100 (12 bytes) + 32 bytes 公钥
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const prefixHex = prefix.toString('hex');
  const derHex = der.toString('hex');
  if (derHex.startsWith(prefixHex)) {
    return der.slice(prefix.length);
  }
  // 回退：尝试提取后 32 字节
  return der.slice(-32);
}

/**
 * 从 PEM 获取 Base64 URL 编码的原始公钥
 */
function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return base64UrlEncode(raw);
}

/**
 * 从公钥计算设备 ID (SHA-256)
 */
function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 构建设备认证 payload (v3 格式)
 */
function buildDeviceAuthPayloadV3(params) {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = params.platform || process.platform;
  const deviceFamily = params.deviceFamily || '';

  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily
  ].join('|');
}

/**
 * 使用私钥签名 payload
 */
function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature);
}

/**
 * 加载设备身份
 */
function loadDeviceIdentity() {
  const filePath = resolveIdentityPath();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string') {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem
      };
    }
  } catch (e) {
    console.error(`Failed to load device identity: ${e.message}`);
  }

  return null;
}

/**
 * 加载设备认证 token
 */
function loadDeviceAuthToken(deviceId) {
  // 优先从 device-auth.json 读取
  const authPath = join(resolveStateDir(), 'identity', 'device-auth.json');

  if (existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.tokens?.operator?.token) {
        return parsed.tokens.operator.token;
      }
    } catch {
      // ignore
    }
  }

  // 回退到旧路径
  const tokenPath = join(resolveStateDir(), 'device-tokens', `${deviceId}.json`);

  if (!existsSync(tokenPath)) {
    return null;
  }

  try {
    const raw = readFileSync(tokenPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.token || null;
  } catch {
    return null;
  }
}

/**
 * OpenClaw 后端框架
 * 把 OpenClaw Gateway 封装成标准 HTTP 服务
 */
export class OpenClawBackend extends EventEmitter {
  constructor(config = {}) {
    super();

    // 加载设备身份
    this.deviceIdentity = loadDeviceIdentity();

    // 配置处理
    this.config = {
      port: config.port || process.env.SERVER_PORT || 3000,
      gatewayUrl: config.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL,
      gatewayHost: config.gatewayHost || process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1',
      gatewayPort: config.gatewayPort || process.env.OPENCLAW_GATEWAY_PORT,
      gatewayToken: config.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN,
      sessionMode: config.session?.mode || process.env.SESSION_MODE || 'memory',
      sessionTimeout: config.session?.timeout || parseInt(process.env.SESSION_TIMEOUT) || 3600000,
      logLevel: config.logLevel || process.env.LOG_LEVEL || 'info'
    };

    // Express 应用
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));

    // 会话管理
    this.sessions = new Map();

    // 工具注册表
    this.tools = new Map();

    // WebSocket 连接池
    this.wsPool = null;

    // 日志
    this.logger = {
      info: (msg) => this.config.logLevel !== 'error' && console.log(`[INFO] ${msg}`),
      warn: (msg) => ['info', 'warn'].includes(this.config.logLevel) && console.warn(`[WARN] ${msg}`),
      error: (msg) => console.error(`[ERROR] ${msg}`),
      debug: (msg) => this.config.logLevel === 'debug' && console.debug(`[DEBUG] ${msg}`)
    };

    // 注册内置路由
    this._registerInternalRoutes();
  }

  /**
   * 自动检测 Gateway 地址
   */
  async detectGateway() {
    if (this.config.gatewayUrl) {
      this.logger.info(`使用配置的 Gateway 地址：${this.config.gatewayUrl}`);
      return this.config.gatewayUrl;
    }

    const port = this.config.gatewayPort;
    if (port) {
      const url = `ws://${this.config.gatewayHost}:${port}`;
      this.logger.info(`使用配置的 Gateway 端口：${port}`);
      return url;
    }

    // 自动检测
    this.logger.info('正在自动检测 OpenClaw Gateway...');
    for (const port of COMMON_PORTS) {
      const url = `ws://${this.config.gatewayHost}:${port}`;
      if (await this._testConnection(url)) {
        this.logger.info(`✅ 检测到 Gateway 在 ${url}`);
        return url;
      }
    }

    throw new Error(
      '未找到 OpenClaw Gateway\n' +
      '请确保 Gateway 正在运行：\n' +
      '  openclaw gateway --port 19000\n' +
      '或设置环境变量：\n' +
      '  OPENCLAW_GATEWAY_PORT=你的端口'
    );
  }

  /**
   * 测试 WebSocket 连接
   */
  async _testConnection(url) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      setTimeout(() => { ws.close(); resolve(false); }, 300);
    });
  }

  /**
   * 注册内部路由（工具调用、健康检查）
   */
  _registerInternalRoutes() {
    // 工具调用接口
    this.app.post('/_tool/:name', async (req, res) => {
      const handler = this.tools.get(req.params.name);
      if (!handler) {
        return res.status(404).json({ error: `Tool not found: ${req.params.name}` });
      }
      try {
        const result = await handler(req.body);
        res.json(result);
      } catch (e) {
        this.logger.error(`Tool ${req.params.name} error: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        gateway: this.wsPool ? 'connected' : 'disconnected',
        deviceIdentity: this.deviceIdentity ? this.deviceIdentity.deviceId.slice(0, 8) : 'none',
        timestamp: new Date().toISOString()
      });
    });

    // 列出可用工具
    this.app.get('/tools', (req, res) => {
      res.json({
        tools: [...this.tools.keys()]
      });
    });
  }

  /**
   * 注册工具（OpenClaw 可以调用的后端接口）
   */
  tool(name, handler) {
    if (typeof handler === 'function') {
      this.tools.set(name, handler);
    } else if (typeof handler === 'object') {
      this.tools.set(name, handler.handler);
    }
    this.logger.debug(`Registered tool: ${name}`);
    return this;
  }

  /**
   * 注册 Skill 路由
   */
  skill(skillName, options = {}) {
    const path = typeof options === 'string' ? options : (options.path || `/${skillName}`);
    const getSessionId = options.sessionId || ((req) => req.body.sessionId || req.ip || 'default');

    // POST /{path}/start
    this.app.post(`${path}/start`, async (req, res) => {
      try {
        const sessionId = getSessionId(req);
        const message = options.actions?.start?.message || '开始';
        const result = await this._invoke(sessionId, message, skillName);
        this.emit('skill:invoked', { skill: skillName, action: 'start', sessionId, result });
        res.json(result);
      } catch (e) {
        this.logger.error(`Skill ${skillName} start error: ${e.message}`);
        res.status(500).json({ error: e.message, skill: skillName });
      }
    });

    // POST /{path}/submit
    this.app.post(`${path}/submit`, async (req, res) => {
      try {
        const sessionId = getSessionId(req);
        const getMessage = options.actions?.submit?.message;
        const message = getMessage ? getMessage(req) : (req.body.message || req.body);
        const result = await this._invoke(sessionId, message, skillName);
        this.emit('skill:invoked', { skill: skillName, action: 'submit', sessionId, result });
        res.json(result);
      } catch (e) {
        this.logger.error(`Skill ${skillName} submit error: ${e.message}`);
        res.status(500).json({ error: e.message, skill: skillName });
      }
    });

    this.logger.debug(`Registered skill: ${skillName} at ${path}`);
    return this;
  }

  /**
   * 注册通用聊天接口
   */
  chat(path = '/chat', sessionIdFn = (req) => req.ip || 'default') {
    this.app.post(path, async (req, res) => {
      try {
        const sessionId = typeof sessionIdFn === 'function' ? sessionIdFn(req) : sessionIdFn;
        const message = req.body.message;
        const result = await this._invoke(sessionId, message);
        res.json(result);
      } catch (e) {
        this.logger.error(`Chat error: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    this.logger.debug(`Registered chat endpoint at ${path}`);
    return this;
  }

  /**
   * 注册自定义 POST 路由（带 OpenClaw 客户端）
   */
  post(path, handler) {
    this.app.post(path, async (req, res) => {
      try {
        await handler(req, res, {
          invoke: (sessionId, message, skill) => this._invoke(sessionId, message, skill)
        });
      } catch (e) {
        this.logger.error(`Custom route ${path} error: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
    return this;
  }

  /**
   * 注册自定义 GET 路由
   */
  get(path, handler) {
    this.app.get(path, async (req, res) => {
      try {
        await handler(req, res, {
          invoke: (sessionId, message, skill) => this._invoke(sessionId, message, skill)
        });
      } catch (e) {
        this.logger.error(`Custom route ${path} error: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
    return this;
  }

  /**
   * 注册中间件
   */
  use(middleware) {
    this.app.use(middleware);
    return this;
  }

  /**
   * 构建 connect 参数
   */
  _buildConnectParams(nonce) {
    const signedAtMs = Date.now();
    const scopes = ['operator.admin', 'operator.read', 'operator.write'];
    const role = 'operator';
    // 使用与设备配对时相同的 client id 和 mode
    const clientId = 'cli';
    const clientMode = 'cli';

    // 基础 connect 参数
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: '1.0.0',
        platform: process.platform,
        mode: clientMode
      },
      caps: [],
      role,
      scopes
    };

    // 如果有设备身份，添加设备签名
    if (this.deviceIdentity) {
      const deviceToken = loadDeviceAuthToken(this.deviceIdentity.deviceId);
      const token = this.config.gatewayToken || deviceToken || '';

      const payload = buildDeviceAuthPayloadV3({
        deviceId: this.deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token,
        nonce,
        platform: process.platform
      });

      const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);

      params.device = {
        id: this.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce
      };

      // 如果有 token，也添加到 auth
      if (token) {
        params.auth = { token };
      }
    } else if (this.config.gatewayToken) {
      // 没有设备身份，只用 token
      params.auth = { token: this.config.gatewayToken };
    }

    return params;
  }

  /**
   * 构建请求帧
   */
  _buildRequestFrame(method, params) {
    return {
      type: 'req',
      id: randomUUID(),
      method,
      params
    };
  }

  /**
   * 调用 OpenClaw Gateway
   */
  async _invoke(sessionId, message, skill = null) {
    if (!this.wsPool) {
      throw new Error('Gateway not connected. Call start() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = 120000; // 120 秒超时
      let authenticated = false;
      let invokeSent = false;

      const ws = new WebSocket(this.wsPool);

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Gateway timeout (120s)'));
      }, timeout);

      // 发送 invoke 请求
      const sendInvoke = () => {
        if (invokeSent) return;
        invokeSent = true;

        this.logger.debug(`Invoking: sessionId=${sessionId}, skill=${skill || 'none'}`);

        // 包装成 request frame，方法名是 'agent'
        // 参数格式需要 message 和 idempotencyKey
        const frame = this._buildRequestFrame('agent', {
          message,
          sessionId,
          idempotencyKey: `${sessionId}-${Date.now()}`,
          // skill 暂时不支持，需要通过其他方式处理
        });

        ws.send(JSON.stringify(frame));
      };

      ws.on('open', () => {
        this.logger.debug(`Connected to Gateway: ${this.wsPool}`);
        // 等待 challenge，不主动发送任何消息
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this.logger.debug(`Received: ${JSON.stringify(event).slice(0, 300)}`);

          // 处理认证挑战
          if (event.event === 'connect.challenge') {
            this.logger.debug('Received connect.challenge');

            const nonce = event.payload?.nonce;
            if (!nonce) {
              reject(new Error('Gateway challenge missing nonce'));
              ws.close();
              return;
            }

            // 构建并发送 connect 请求帧
            const params = this._buildConnectParams(nonce);
            const frame = this._buildRequestFrame('connect', params);

            this.logger.debug(`Sending connect request frame`);

            ws.send(JSON.stringify(frame));
            return;
          }

          // 处理连接响应
          if (event.type === 'res' && event.ok) {
            // 这是响应帧
            const payload = event.payload;

            // 检查是否是 connect 响应 (hello-ok)
            if (payload && (payload.type === 'hello-ok' || payload.protocol || payload.server)) {
              this.logger.debug('Gateway connection established');
              authenticated = true;
              sendInvoke();
              return;
            }

            // agent 请求被接受，等待最终结果
            if (payload && payload.status === 'accepted') {
              this.logger.debug('Agent request accepted, waiting for response...');
              return; // 继续等待 agent 事件
            }

            // agent 最终响应
            if (payload && payload.result) {
              clearTimeout(timer);
              this.logger.debug('Got agent result');
              // 返回简化的响应
              resolve({
                payloads: payload.result.payloads,
                meta: payload.result.meta
              });
              ws.close();
              return;
            }

            // 其他成功响应
            clearTimeout(timer);
            this.logger.debug('Got success response');
            resolve(payload || event);
            ws.close();
            return;
          }

          // 处理错误响应
          if (event.type === 'res' && !event.ok) {
            clearTimeout(timer);
            const errMsg = event.error?.message || JSON.stringify(event.error);
            reject(new Error(`Gateway error: ${errMsg}`));
            ws.close();
            return;
          }

          // 处理事件（可能是 agent 的流式输出）
          if (event.type === 'event') {
            // 忽略 tick, health 等系统事件
            if (event.event === 'tick' || event.event === 'health') {
              return;
            }

            // agent 相关事件
            if (event.event === 'agent' && event.payload) {
              const agentPayload = event.payload;

              // lifecycle 事件 - 只记录状态
              if (agentPayload.stream === 'lifecycle') {
                this.logger.debug(`Agent lifecycle: ${agentPayload.data?.phase}`);
                return;
              }

              // 检查是否是最终响应
              if (agentPayload.type === 'response' ||
                  agentPayload.stream === 'response' ||
                  agentPayload.data?.type === 'response') {
                clearTimeout(timer);
                this.logger.debug('Got agent response');

                // 提取实际的响应内容
                const response = agentPayload.data || agentPayload;
                resolve(response);
                ws.close();
                return;
              }

              // payloads 形式的响应
              if (agentPayload.payloads) {
                clearTimeout(timer);
                this.logger.debug('Got agent payloads');
                resolve(agentPayload);
                ws.close();
                return;
              }

              // 其他 agent 事件继续等待
              return;
            }

            // chat 事件
            if (event.event === 'chat' && event.payload) {
              clearTimeout(timer);
              this.logger.debug('Got chat response');
              resolve(event.payload);
              ws.close();
              return;
            }

            // 其他带 payloads 的事件
            if (event.payloads) {
              clearTimeout(timer);
              this.logger.debug('Got payloads event');
              resolve(event);
              ws.close();
              return;
            }
          }

          // 未处理的消息，记录并继续等待
          this.logger.debug(`Unhandled message type: ${event.type || event.event}`);

        } catch (e) {
          clearTimeout(timer);
          reject(new Error(`Parse error: ${e.message}`));
          ws.close();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Gateway error: ${err.message}`));
      });

      ws.on('close', (code, reason) => {
        if (!authenticated && !invokeSent) {
          clearTimeout(timer);
          const reasonText = reason.toString() || `code ${code}`;
          reject(new Error(`Gateway connection closed: ${reasonText}`));
        }
      });
    });
  }

  /**
   * 启动服务
   */
  async start() {
    try {
      // 检测/连接 Gateway
      const gatewayUrl = await this.detectGateway();
      this.wsPool = gatewayUrl;

      // 启动 HTTP 服务器
      await new Promise((resolve) => {
        this.server = this.app.listen(this.config.port, () => {
          resolve();
        });
      });

      this.logger.info(`🚀 OpenClaw Backend running on http://localhost:${this.config.port}`);
      this.logger.info(`🔗 Gateway: ${gatewayUrl}`);

      if (this.deviceIdentity) {
        this.logger.info(`🔐 Device: ${this.deviceIdentity.deviceId.slice(0, 8)}...`);
      } else {
        this.logger.warn(`⚠️  No device identity found. Run 'openclaw config' first.`);
      }

      this.logger.info(`📦 Registered tools: ${[...this.tools.keys()].join(', ') || 'none'}`);
      this.logger.info(`💡 Available skills: use app.skill() to register`);

      this.emit('started', { port: this.config.port, gateway: gatewayUrl });

    } catch (err) {
      this.logger.error(`❌ Failed to start: ${err.message}`);
      console.error('\nTroubleshooting:');
      console.error('1. Make sure OpenClaw Gateway is running:');
      console.error('   openclaw gateway start\n');
      console.error('2. Or set the correct port:');
      console.error('   OPENCLAW_GATEWAY_PORT=your-port\n');
      console.error('3. Make sure device is paired:');
      console.error('   openclaw devices list\n');
      process.exit(1);
    }

    return this;
  }

  /**
   * 停止服务
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info('Server stopped');
    }
  }
}

// 默认导出
export default OpenClawBackend;