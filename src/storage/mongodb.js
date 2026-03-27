/**
 * MongoDB Storage Layer for OpenClaw Backend
 */

import mongoose from 'mongoose';

// ====== 数据模型定义 ======

// 用户模型
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  exhaustType: { type: String, default: null },
  assessResult: { type: [String], default: [] },
  assessDate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 对话模型
const ConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  role: { type: String, required: true, enum: ['user', 'assistant'] },
  content: { type: String, required: true },
  time: { type: Date, default: Date.now }
});

// 养护计划模型
const CarePlanSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  tasks: [{
    templateId: { type: String, required: true },
    customContent: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  progressMessage: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 创建模型
const User = mongoose.model('User', UserSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);
const CarePlan = mongoose.model('CarePlan', CarePlanSchema);

// ====== 存储服务 ======

class MongoStorage {
  constructor() {
    this.connected = false;
  }

  /**
   * 连接 MongoDB
   * @param {string} uri - MongoDB 连接字符串
   */
  async connect(uri) {
    if (this.connected) return;

    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000
      });
      this.connected = true;
      console.log('[MongoDB] Connected successfully');
    } catch (err) {
      console.error('[MongoDB] Connection error:', err.message);
      throw err;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (this.connected) {
      await mongoose.disconnect();
      this.connected = false;
      console.log('[MongoDB] Disconnected');
    }
  }

  // ====== 用户操作 ======

  async getUser(userId) {
    return await User.findOne({ userId });
  }

  async createUser(userId) {
    const user = new User({ userId });
    return await user.save();
  }

  async updateUser(userId, data) {
    return await User.findOneAndUpdate(
      { userId },
      { ...data, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  }

  // ====== 对话操作 ======

  async getConversations(userId, limit = 20) {
    return await Conversation.find({ userId })
      .sort({ time: -1 })
      .limit(limit)
      .lean();
  }

  async addConversation(userId, role, content) {
    const conv = new Conversation({ userId, role, content });
    return await conv.save();
  }

  async getRecentConversations(userId, limit = 5) {
    return await Conversation.find({ userId })
      .sort({ time: -1 })
      .limit(limit)
      .lean();
  }

  // ====== 养护计划操作 ======

  async getCarePlan(userId) {
    return await CarePlan.findOne({ userId });
  }

  async updateCarePlan(userId, carePlan) {
    return await CarePlan.findOneAndUpdate(
      { userId },
      { ...carePlan, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  }

  // ====== 旅程统计 ======

  async getJourneyStats(userId) {
    const userMessages = await Conversation.countDocuments({ userId, role: 'user' });

    // 按日期分组
    const byDate = await Conversation.aggregate([
      { $match: { userId } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$time' } },
        count: { $sum: 1 },
        firstUserMessage: {
          $first: {
            $cond: [{ $eq: ['$role', 'user'] }, '$content', null]
          }
        }
      }},
      { $sort: { _id: -1 } },
      { $limit: 30 }
    ]);

    const timeline = byDate.map(item => ({
      date: item._id,
      content: item.firstUserMessage?.slice(0, 50) || '',
      status: '已记录'
    }));

    return {
      stats: {
        stonesCleared: userMessages,
        consecutiveDays: byDate.length
      },
      timeline
    };
  }

  // ====== 健康检查 ======

  async healthCheck() {
    if (!this.connected) return { status: 'disconnected' };
    try {
      await mongoose.connection.db.admin().ping();
      return { status: 'healthy' };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }
}

// 导出单例
export const mongoStorage = new MongoStorage();
export { User, Conversation, CarePlan };