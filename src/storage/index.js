/**
 * 存储抽象层
 * 开发环境使用 JSON 文件，生产环境使用 MongoDB
 */

import { mongoStorage } from './mongodb.js';
import { config, useMongoDB } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// 获取当前目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// JSON 文件存储实现
class JsonFileStorage {
  constructor() {
    const DATA_DIR = join(homedir(), '.xinshi-assistant');
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    this.dbFile = join(DATA_DIR, 'data.json');
  }

  loadData() {
    if (!existsSync(this.dbFile)) {
      return { users: {}, conversations: {}, carePlans: {} };
    }
    try {
      return JSON.parse(readFileSync(this.dbFile, 'utf8'));
    } catch (e) {
      return { users: {}, conversations: {}, carePlans: {} };
    }
  }

  saveData(data) {
    writeFileSync(this.dbFile, JSON.stringify(data, null, 2));
  }

  // ====== 用户操作 ======
  async getUser(userId) {
    const data = this.loadData();
    return data.users[userId] || null;
  }

  async createUser(userId) {
    const data = this.loadData();
    if (!data.users[userId]) {
      data.users[userId] = {};
      data.conversations[userId] = [];
      data.carePlans[userId] = null;
      this.saveData(data);
    }
    return data.users[userId];
  }

  async updateUser(userId, updates) {
    const data = this.loadData();
    if (!data.users[userId]) {
      data.users[userId] = {};
      data.conversations[userId] = [];
      data.carePlans[userId] = null;
    }
    Object.assign(data.users[userId], updates);
    this.saveData(data);
    return data.users[userId];
  }

  // ====== 对话操作 ======
  async getConversations(userId, limit = 20) {
    const data = this.loadData();
    const convos = data.conversations[userId] || [];
    return convos.slice(-limit);
  }

  async addConversation(userId, role, content) {
    const data = this.loadData();
    if (!data.conversations[userId]) {
      data.conversations[userId] = [];
    }
    data.conversations[userId].push({
      role,
      content,
      time: new Date().toISOString()
    });
    this.saveData(data);
  }

  async getRecentConversations(userId, limit = 5) {
    const data = this.loadData();
    const convos = data.conversations[userId] || [];
    return convos.slice(-limit);
  }

  // ====== 养护计划操作 ======
  async getCarePlan(userId) {
    const data = this.loadData();
    return data.carePlans[userId] || null;
  }

  async updateCarePlan(userId, carePlan) {
    const data = this.loadData();
    data.carePlans[userId] = carePlan;
    this.saveData(data);
    return carePlan;
  }

  // ====== 旅程统计 ======
  async getJourneyStats(userId) {
    const data = this.loadData();
    const conversations = data.conversations[userId] || [];

    const userMessages = conversations.filter(c => c.role === 'user');
    const stonesCleared = userMessages.length;

    // 按日期分组
    const byDate = {};
    conversations.forEach(c => {
      const date = c.time?.split('T')[0] || 'unknown';
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(c);
    });

    const timeline = Object.entries(byDate)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30)
      .map(([date, convos]) => {
        const userConvo = convos.find(c => c.role === 'user');
        return {
          date,
          content: userConvo?.content?.slice(0, 50) || '',
          status: '已记录'
        };
      });

    return {
      stats: {
        stonesCleared,
        consecutiveDays: Object.keys(byDate).length
      },
      timeline
    };
  }

  // ====== 健康检查 ======
  async healthCheck() {
    return { status: 'healthy', type: 'json-file' };
  }
}

// 根据环境选择存储实现
let storageInstance = null;

export async function getStorage() {
  if (storageInstance) return storageInstance;

  if (useMongoDB()) {
    console.log('[Storage] Using MongoDB');
    await mongoStorage.connect(config.mongodbUri);
    storageInstance = mongoStorage;
  } else {
    console.log('[Storage] Using JSON file (development)');
    storageInstance = new JsonFileStorage();
  }

  return storageInstance;
}

// 用于构建记忆 prompt 的数据获取
export async function getMemoryData(userId) {
  const storage = await getStorage();

  const user = await storage.getUser(userId);
  const recentConvos = await storage.getRecentConversations(userId, 5);

  return {
    profile: user || {},
    conversations: recentConvos.reverse() // 按时间正序
  };
}