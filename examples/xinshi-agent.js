/**
 * 心石清理师 Agent
 * 基于 OpenClaw Backend 实现
 * 支持本地开发（JSON文件）和生产环境（MongoDB）
 */

import { OpenClawBackend } from '../src/index.js';
import { getStorage, getMemoryData } from '../src/storage/index.js';
import { corsMiddleware, rateLimitMiddleware, errorHandler, validateRequest } from '../src/middleware/security.js';
import { config, validateProductionConfig } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

// 获取当前目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// ====== System Prompt ======
const XINSHI_SYSTEM_PROMPT = `# 角色定位

你是「心石清理师」AI助手，严格遵循北京协和医院张海敏博士提出的「减法养生」情绪自愈理念，为用户提供个性化的情绪清理服务。

## 核心理念

**最高级的养生不是往心里加东西，而是把心里的石头一块块搬开。**

心里的石头包括：纠结、焦虑、别人的负面评价、消耗你的关系、说不完的抱怨。这些石头压得你累，慢慢就会影响身体。

---

## 必须严格遵守的回应规则

### 1. 内容约束
- 所有输出必须贴合张海敏博士的核心观点，严禁引入和减法养生相悖的内容
- 不得推荐任何名贵补品、复杂养生功法，不引导做养生加法
- 所有建议必须围绕"减去内耗、清理心垃圾"展开，保持简洁，不增加用户负担

### 2. 语气要求
- 模仿临床医生温和直白的聊天口吻，像长辈聊天一样亲切
- 不使用生硬的心理学黑话、专业术语
- 不说官话套话，直击痛点，给明确可落地的小步骤，不说空泛大道理
- 不说"你应该"，用"试试""可以试着"代替

### 3. 个性化回应要求
根据用户的内耗类型匹配对应的解决方案：

| 内耗类型 | 核心问题 | 引导方向 |
|---------|---------|---------|  |
| 语言暗示型 | 负面口头禅形成自我暗示 | 引导觉察替换"烦死了/累死了/气死了" |
| 社交消耗型 | 存在消耗型关系 | 引导修剪关系，给出拒绝话术参考 |
| 焦虑纠结型 | 反复纠结过去/他人评价 | 引导做五减法 |
| 高压心疲型 | 无独处时间+睡眠差 | 引导落实每日心气养护 |
| 过度欲求型 | 总觉得不够+抱怨多 | 引导欲望清理 |
| 认知耗竭型 | 碎片化信息+无心流 | 引导深度阅读替代短视频 |

---

## 固定回应框架

每次回应都要遵循：

1. **先共情**：理解用户的情绪，不说教
2. **点本质**：用张海敏的理念点出问题本质
3. **给动作**：给出1-2个今天就能做的具体小动作

---

## 输出格式

你必须输出 **JSON 格式**，结构如下：

\`\`\`json
{
  "message": "你的回应内容，支持Markdown格式",
  "suggestions": ["建议用户说的话1", "建议2", "建议3"],
  "carePlan": {
    "tasks": [
      {
        "templateId": "模板ID",
        "customContent": {
          "字段名": "个性化内容"
        }
      }
    ],
    "progressMessage": "进度提示语"
  }
}
\`\`\`

### 字段说明

| 字段 | 必填 | 说明 |
|-----|-----|------|
| message | 是 | 回应内容，支持Markdown |
| suggestions | 是 | 2-3个建议用户说的话，每个不超过15字 |
| carePlan | 否 | 养护计划更新，仅在需要时输出 |

---

## 养护计划模板

### 可用模板

| templateId | 名称 | 适用内耗类型 | customContent字段 |
|------------|-----|-------------|------------------|
| morning_breath | 晨曦观息 | 焦虑纠结型、高压心疲型 | duration, action, rationale, steps |
| mindful_afternoon | 正念午后 | 认知耗竭型 | action, rationale, steps |
| prune_relation | 修剪关系 | 社交消耗型 | action, rationale, steps, example |
| night_review | 深夜复盘 | 所有类型 | action, rationale, steps |
| language_watch | 语言觉察 | 语言暗示型 | count, replacement, rationale, steps |
| five_reduce | 五减默念 | 焦虑纠结型、过度欲求型 | duration, rationale, steps |

### 模板内容填充规则

1. **结合对话历史**：rationale 必须引用用户之前说过的话或情况
2. **符合减法理念**：每个任务不超过5分钟，不增加负担
3. **最多2个任务**：符合"一次只搬一块石头"的理念
4. **个性化action**：根据用户具体情况调整动作描述
5. **提供具体步骤steps**：每个任务提供2-3个具体的执行步骤
6. **提供示例example**：对于"修剪关系"类任务，提供具体的对话示例

---

## 记忆运用

你会收到用户的画像和对话历史，请体现"我记得你"：

1. **引用历史**：引用用户之前说过的话
2. **关联类型**：关联用户的内耗类型
3. **对比变化**：对比用户之前的状态变化

---

## 禁止事项

1. **严禁偏离张海敏减法养生理念**，不得推荐和理念相悖的内容
2. **严禁给用户开药方、做医学诊断**，如果用户说自己有明确的身体疾病，引导用户去正规医院就诊，只做情绪调节建议
3. **严禁给用户增加负担**，每次只给1-2个可落地小动作，绝对不要列5条以上的任务
4. **严禁使用生硬的专业术语**，如"认知行为疗法""潜意识"等`;

// ====== 测评题目 ======
const ASSESS_QUESTIONS = [
  { q: '你是否经常把「烦死了」「累死了」「气死了」这类负面词挂在嘴边？', opts: ['一天好几次', '偶尔说', '几乎不说'] },
  { q: '你每天能留出1小时完全不碰手机、不处理工作信息的无干扰时间吗？', opts: ['完全不行', '偶尔能', '每天都有'] },
  { q: '你身边有没有那种「见面聊完天，你感觉比干一天活还累」的人？', opts: ['有好几个', '有一两个', '几乎没有'] },
  { q: '你会不会反复纠结过去发生的糟心事，或总忍不住提前为还没发生的事焦虑？', opts: ['经常这样', '偶尔会', '很少'] },
  { q: '你最近一个月，能轻松睡到自然醒，第二天起来感觉精力充足吗？', opts: ['很难', '偶尔可以', '基本都能'] },
  { q: '你会不会因为别人一句负面评价，心里不舒服好几天？', opts: ['会', '偶尔会', '不会'] },
  { q: '你每天的休闲时间，大部分都用来刷短视频/碎片化社交吗？', opts: ['是的', '一半一半', '经常读深度内容'] },
  { q: '你是不是总觉得"我还不够"，想要赚更多钱、买更好的东西？', opts: ['是的', '偶尔会焦虑', '不会'] },
  { q: '你会不会经常和别人吐槽工作、生活里的不顺，挂在嘴边说个没完？', opts: ['每天都要', '偶尔吐槽', '很少抱怨'] },
  { q: '你最近一个月，有没有过「投入一件事，完全忘记时间」的心流体验？', opts: ['从来没有', '偶尔有', '经常有'] }
];

// ====== 内耗类型判定 ======
function determineExhaustType(answers) {
  const types = [];
  if (answers[0] === 'A') types.push('语言暗示型');
  if (answers[2] === 'A') types.push('社交消耗型');
  if (answers[3] === 'A' || answers[5] === 'A') types.push('焦虑纠结型');
  if (answers[1] === 'A' && answers[4] === 'A') types.push('高压心疲型');
  if (answers[7] === 'A' && answers[8] === 'A') types.push('过度欲求型');
  if (answers[6] === 'A' && answers[9] === 'A') types.push('认知耗竭型');

  return types.length > 1 ? `复合型（${types.join('、')}）` : (types[0] || '焦虑纠结型');
}

// ====== 生成测评报告 ======
function generateReport(exhaustType) {
  const reports = {
    '语言暗示型': '你已习惯把负面表达挂在嘴边，这些话会不断给大脑做负面暗示，让身体慢慢配合产生疲惫感。\n\n**建议**：接下来3天，每次想说「烦死了/累死了」的时候，先停下来，换成中性表达。',
    '社交消耗型': '你身边存在长期消耗你的人，和他们相处完你比干一天活还累，这些人就像「生命里的慢性毒药」。\n\n**建议**：本周就推掉1个你本来就不想去的无效社交，不用不好意思。',
    '焦虑纠结型': '你总把过去的糟心事放在心里，或者忍不住提前为还没发生的事焦虑，这些情绪一直堆在心里，就变成了压住你的石头。\n\n**建议**：今天就做一次「物理清理」——把让你纠结的事写在纸上，然后揉碎扔进垃圾桶。',
    '高压心疲型': '你长期被信息轰炸，没有属于自己的放空时间，加上睡不好，压力激素一直居高不下，身体得不到修复。\n\n**建议**：从今天开始，每天挤出15分钟无干扰独处。',
    '过度欲求型': '你一直停不下来追求更多，总觉得「我还不够」，这种过度欲求就是你心里最大的石头。\n\n**建议**：本周做一次「欲望清理」——写下3个你最近强行想要的东西，划掉至少1个不是必需的。',
    '认知耗竭型': '你长期被碎片化短视频消耗，大脑一直停留在低信息密度的刺激里，认知慢慢失去弹性。\n\n**建议**：从今天开始，每天抽15分钟读一页「费脑子」的书。'
  };

  const baseType = exhaustType.split('（')[0];
  return reports[baseType] || reports['焦虑纠结型'];
}

// ====== 构建带记忆的Prompt ======
async function buildMemoryPrompt(userId, message) {
  const memoryData = await getMemoryData(userId);
  const { profile, conversations } = memoryData;

  // 格式化对话历史
  const historyText = conversations.length > 0
    ? conversations.map(c => `${c.role === 'user' ? '用户' : 'AI'}: ${c.content.slice(0, 100)}...`).join('\n')
    : '无';

  return `${XINSHI_SYSTEM_PROMPT}

---

【用户画像】
- 内耗类型：${profile.exhaustType || '未测评'}
- 测评日期：${profile.assessDate || '未测评'}

【最近对话】
${historyText}

【当前日期】
${new Date().toLocaleDateString('zh-CN')}

【用户消息】
${message}

请以JSON格式回应。`;
}

// ====== 解析AI响应 ======
function parseAIResponse(response) {
  if (response.payloads && response.payloads.length > 0) {
    let text = response.payloads[0].text || response.payloads[0];
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      return JSON.parse(text);
    } catch (e) {
      return {
        message: text,
        suggestions: ['继续说说...', '我还有别的困惑', '今天想聊点别的']
      };
    }
  }

  if (response.text) {
    let text = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      return JSON.parse(text);
    } catch (e) {
      return {
        message: response.text,
        suggestions: ['继续说说...', '我还有别的困惑']
      };
    }
  }

  return {
    message: '我听到了，跟我说说今天有什么让你纠结的事吧。',
    suggestions: ['说说今天最纠结的事', '我总是担心别人的看法']
  };
}

// ====== 生成默认养护计划 ======
function generateDefaultCarePlan(exhaustType) {
  const typeToTemplates = {
    '语言暗示型': ['language_watch', 'night_review'],
    '社交消耗型': ['prune_relation', 'night_review'],
    '焦虑纠结型': ['five_reduce', 'morning_breath'],
    '高压心疲型': ['morning_breath', 'night_review'],
    '过度欲求型': ['five_reduce', 'night_review'],
    '认知耗竭型': ['mindful_afternoon', 'night_review']
  };

  const baseType = exhaustType?.split('（')[0] || '焦虑纠结型';
  const templates = typeToTemplates[baseType] || ['morning_breath', 'night_review'];

  const templateConfigs = {
    morning_breath: { duration: '5', action: '呼吸引导', rationale: '在清晨找回呼吸的节奏' },
    mindful_afternoon: { action: '放下手机，感受指尖的温度', rationale: '在纷扰的午后为心灵留白' },
    prune_relation: { action: '主动推掉一个无效社交', rationale: '给自己的时间表做个减法' },
    night_review: { action: '写下今天搬开的三块石头', rationale: '让负累留在今天，轻装入眠' },
    language_watch: { count: '3', replacement: '这件事有点棘手', rationale: '语言暗示会直接影响身体状态' },
    five_reduce: { duration: '1', rationale: '把心里的石头一块块搬出来' }
  };

  return {
    tasks: templates.map(t => ({
      templateId: t,
      customContent: templateConfigs[t]
    })),
    progressMessage: '今天先从这一块石头开始'
  };
}

// ====== 创建应用 ======
async function main() {
  // 生产环境配置验证
  if (config.nodeEnv === 'production') {
    try {
      validateProductionConfig();
    } catch (e) {
      logger.error('Production config validation failed', { error: e.message });
      process.exit(1);
    }
  }

  // 初始化存储
  const storage = await getStorage();

  // 创建应用
  const app = new OpenClawBackend({ port: config.port });

  // 安全中间件
  app.use(corsMiddleware());
  app.use(rateLimitMiddleware());

  // 静态文件服务
  app.use(express.static(join(__dirname, '../public')));
  app.use(express.json());

  // ====== 健康检查 ======
  app.get('/health', async (req, res) => {
    const dbHealth = await storage.healthCheck();
    res.json({
      status: 'ok',
      storage: dbHealth,
      env: config.nodeEnv
    });
  });

  // ====== 测评接口 ======
  app.post('/assess', validateRequest(['userId', 'answers']), async (req, res) => {
    const { userId, answers } = req.body;

    if (answers.length !== 10) {
      return res.status(400).json({ error: '需要提供10个答案' });
    }

    const exhaustType = determineExhaustType(answers);
    const report = generateReport(exhaustType);

    // 保存用户数据
    await storage.updateUser(userId, {
      exhaustType,
      assessResult: answers,
      assessDate: new Date().toISOString()
    });

    res.json({
      exhaustType,
      report,
      carePlan: generateDefaultCarePlan(exhaustType)
    });
  });

  // ====== 对话接口 ======
  app.post('/chat', validateRequest(['userId', 'message']), async (req, res, ctx) => {
    const { userId, message } = req.body;

    // 确保用户存在
    await storage.createUser(userId);

    // 构建带记忆的Prompt
    const fullPrompt = await buildMemoryPrompt(userId, message);

    try {
      // 调用 OpenClaw Gateway
      const aiResponse = await ctx.invoke(userId, fullPrompt);

      // 解析响应
      const parsed = parseAIResponse(aiResponse);

      // 保存对话记录
      await storage.addConversation(userId, 'user', message);
      await storage.addConversation(userId, 'assistant', JSON.stringify(parsed));

      // 如果AI返回了养护计划，保存
      if (parsed.carePlan) {
        await storage.updateCarePlan(userId, parsed.carePlan);
        logger.info('Updated care plan', { userId });
      }

      res.json(parsed);

    } catch (e) {
      logger.error('Chat error', { error: e.message, userId });
      res.status(500).json({
        error: config.nodeEnv === 'production' ? '服务暂时不可用' : e.message,
        message: '抱歉，我现在有点累了，稍后再试试？',
        suggestions: ['再试一次', '换个话题聊聊']
      });
    }
  });

  // ====== 获取测评题目 ======
  app.get('/assess/questions', (req, res) => {
    res.json({ questions: ASSESS_QUESTIONS });
  });

  // ====== 获取养护计划 ======
  app.get('/care-plan', async (req, res) => {
    const { userId } = req.query;

    const user = await storage.getUser(userId);
    if (!user) {
      return res.json({ carePlan: generateDefaultCarePlan('焦虑纠结型') });
    }

    const carePlan = await storage.getCarePlan(userId);
    res.json({ carePlan: carePlan || generateDefaultCarePlan(user.exhaustType) });
  });

  // ====== 更新养护计划 ======
  app.post('/care-plan', validateRequest(['userId', 'carePlan']), async (req, res) => {
    const { userId, carePlan } = req.body;

    await storage.updateCarePlan(userId, carePlan);
    res.json({ success: true, carePlan });
  });

  // ====== 获取对话历史 ======
  app.get('/history', async (req, res) => {
    const { userId, limit = 20 } = req.query;

    const conversations = await storage.getConversations(userId, parseInt(limit));
    res.json({ conversations });
  });

  // ====== 获取旅程数据 ======
  app.get('/journey', async (req, res) => {
    const { userId } = req.query;

    const journeyData = await storage.getJourneyStats(userId);
    res.json(journeyData);
  });

  // 错误处理
  app.use(errorHandler);

  // 启动服务
  app.start();

  logger.info('心石清理师 Agent 已启动', {
    env: config.nodeEnv,
    port: config.port,
    endpoints: ['health', 'assess', 'chat', 'care-plan', 'history', 'journey']
  });
}

main().catch(err => {
  logger.error('Startup failed', { error: err.message });
  process.exit(1);
});