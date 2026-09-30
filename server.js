import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SHARED_DIR = path.join(DATA_DIR, 'shared');

const app = express();
// 不暴露 Express 指纹，减少被针对性扫描的风险
app.disable('x-powered-by');
// 信任反向代理（Nginx），确保 req.ip 获取真实客户端 IP
app.set('trust proxy', 1);
app.use(cors());

// ===== gzip 压缩（516KB 的 index.html 压缩后约 100KB，首屏加载提速 4-5 倍）=====
// 注意：SSE（text/event-stream）绝不能压缩，否则流式输出会被缓冲，前端迟迟不出字
app.use(compression({
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    if (ct.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

// ===== 基础安全响应头 =====
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ===== 请求日志中间件 =====
// 记录每个请求的方法、路径、状态码、响应时间，便于排查问题
app.use((req, res, next) => {
    const start = Date.now();
    // 响应结束时记录日志
    res.on('finish', () => {
        const duration = Date.now() - start;
        const log = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
        // 只记录非200响应或慢请求，避免日志过多
        if (res.statusCode >= 400 || duration > 1000) {
            console.log(log);
        }
    });
    next();
});

// ===== 请求体大小限制（细粒度控制）=====
// 注意：路由级别的限制需要在具体路由前设置，全局限制保留500kb作为兜底
app.use(express.json({ limit: '500kb' }));

// 捕获未处理的Promise rejection，防止进程退出
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    // 致命错误时优雅退出
    gracefulShutdown('uncaughtException');
});

// ===== 配置 =====
// 从环境变量中智能选择有效的API Key（trim空格、跳过占位符）
const PLACEHOLDER_KEYS = ['', 'sk-your-key-here', 'your-key-here', 'your_api_key', 'xxx', 'placeholder', 'changeme'];

// 火山引擎ARK端点（兼容OpenAI格式）
const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
// 阿里云百炼DashScope端点（兼容OpenAI格式）
const ALIYUN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// 清洗环境变量：剥除前后空白，以及误从Markdown/复制粘贴带入的反引号、单双引号
// 例如 export ARK_API_URL=`https://...` 或 "https://..." 会被自动修正
function cleanEnv(val) {
  if (val === undefined || val === null) return '';
  let s = String(val).trim();
  // 反复剥除成对或残留的包裹字符：` ' " 以及零宽字符
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
  return s.trim();
}
function getEnv(name) {
  return cleanEnv(process.env[name]);
}

function isPlaceholderOrInvalid(val) {
  const trimmed = cleanEnv(val);
  if (!trimmed) return true;
  if (trimmed.length <= 10) return true;
  if (PLACEHOLDER_KEYS.includes(trimmed.toLowerCase())) return true;
  return false;
}

function pickValidKey() {
  const candidates = [
    // 火山引擎相关（最高优先）
    ['VOLC_API_KEY', process.env.VOLC_API_KEY],
    ['ARK_API_KEY', process.env.ARK_API_KEY],
    ['VOLCENGINE_API_KEY', process.env.VOLCENGINE_API_KEY],
    // 通用/自定义
    ['API_KEY', process.env.API_KEY],
    ['YUZHOU_API_KEY', process.env.YUZHOU_API_KEY],
    // 阿里云相关
    ['DASHSCOPE_API_KEY', process.env.DASHSCOPE_API_KEY],
    ['ALIYUN_API_KEY', process.env.ALIYUN_API_KEY],
    // OpenAI兼容
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
  ];
  const valid = candidates.filter(([, val]) => !isPlaceholderOrInvalid(val))
    .map(([name, val]) => ({ name, key: cleanEnv(val) }));
  if (valid.length === 0) return { key: '', source: null };

  // 强信号：只要存在以 ark- 开头的Key（火山引擎专用前缀），无条件优先使用，
  // 即便服务器残留了通用 API_KEY=sk-xxx（旧阿里云Key）也不会被误用。
  const arkKey = valid.find(v => v.key.toLowerCase().startsWith('ark-'));
  if (arkKey) return { key: arkKey.key, source: arkKey.name };

  // 否则按候选顺序返回第一个有效Key
  return { key: valid[0].key, source: valid[0].name };
}
const { key: API_KEY, source: API_KEY_SOURCE } = pickValidKey();

// 根据 来源变量名 / URL / 模型名 / Key前缀 综合判断是火山引擎还是阿里云
// keyValue 是最可靠的信号：ark- => 火山引擎；sk- 通常为阿里云/OpenAI
function detectProvider(source, url = '', model = '', keyValue = '') {
  const s = String(source || '').toLowerCase();
  const u = String(url || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  const k = String(keyValue || '').toLowerCase();

  // 1) Key前缀是最强信号
  if (k.startsWith('ark-')) return 'volcengine';

  // 2) 来源变量名 / URL / 模型名(ep-前缀)
  if (s.includes('volc') || s.includes('ark') || s.includes('volcengine') ||
      u.includes('volces.com') || u.includes('ark.cn-') || m.startsWith('ep-')) return 'volcengine';
  if (s.includes('dashscope') || s.includes('aliyun') || u.includes('dashscope.aliyuncs.com')) return 'aliyun';

  // 3) sk- 前缀且无火山信号时按阿里云/OpenAI兼容处理
  if (k.startsWith('sk-')) return 'aliyun';
  return 'custom';
}

// API端点：显式配置的URL优先，兼容“基础URL”和“完整/chat/completions URL”两种写法
const URL_CANDIDATES = [
  getEnv('API_URL'),
  getEnv('YUZHOU_API_URL'),
  getEnv('ARK_API_URL'),
  getEnv('VOLC_API_URL'),
  getEnv('VOLCENGINE_API_URL'),
  getEnv('DASHSCOPE_API_URL')
];
const RAW_API_URL = (URL_CANDIDATES.find(u => u && u.trim()) || '').trim().replace(/\/+$/, '');

// 先用 Key前缀 + URL 判定provider（此时还未引入易污染的MODEL_NAME）
const API_PROVIDER = detectProvider(API_KEY_SOURCE, RAW_API_URL, '', API_KEY);

// ===== 模型名：按provider做“提供商感知”的选择，避免残留环境变量污染 =====
// 火山引擎模型应为 Endpoint ID（ep-开头）或 doubao 系列；阿里云为 qwen 系列。
function looksLikeVolcModel(m) {
  const x = String(m || '').toLowerCase();
  return x.startsWith('ep-') || x.startsWith('doubao') || x.startsWith('volc');
}
function looksLikeAliyunModel(m) {
  const x = String(m || '').toLowerCase();
  return x.startsWith('qwen') || x.startsWith('qwq') || x.startsWith('qvq') || x.startsWith('deepseek');
}

// 火山专用模型变量（优先级最高，确保即便残留 MODEL_NAME=qwen 也不会污染）
const VOLC_MODEL_CANDIDATES = [getEnv('ARK_MODEL'), getEnv('VOLC_MODEL'), getEnv('VOLCENGINE_MODEL')];
// 阿里云专用模型变量
const ALIYUN_MODEL_CANDIDATES = [getEnv('DASHSCOPE_MODEL'), getEnv('ALIYUN_MODEL')];
// 通用模型变量
const GENERIC_MODEL_CANDIDATES = [getEnv('MODEL_NAME'), getEnv('YUZHOU_MODEL')];

function firstNonEmpty(arr) {
  return (arr.find(m => m && typeof m === 'string' && m.trim()) || '').trim();
}

function resolveModelName(provider) {
  if (provider === 'volcengine') {
    // 1) 火山专用变量优先
    const volc = firstNonEmpty(VOLC_MODEL_CANDIDATES);
    if (volc) return volc;
    // 2) 通用变量但必须“像”火山模型，否则丢弃（防止 qwen 污染导致 404）
    const generic = firstNonEmpty(GENERIC_MODEL_CANDIDATES);
    if (generic && looksLikeVolcModel(generic)) return generic;
    // 3) 兜底默认
    return 'doubao-pro-32k';
  }
  if (provider === 'aliyun') {
    const aly = firstNonEmpty(ALIYUN_MODEL_CANDIDATES);
    if (aly) return aly;
    const generic = firstNonEmpty(GENERIC_MODEL_CANDIDATES);
    if (generic && !looksLikeVolcModel(generic)) return generic;
    return 'qwen-plus';
  }
  // custom：按配置顺序取第一个非空
  return firstNonEmpty([...VOLC_MODEL_CANDIDATES, ...ALIYUN_MODEL_CANDIDATES, ...GENERIC_MODEL_CANDIDATES]) || 'doubao-pro-32k';
}

const RAW_MODEL_NAME = resolveModelName(API_PROVIDER);
const DEFAULT_MODEL = API_PROVIDER === 'aliyun' ? 'qwen-plus' : 'doubao-pro-32k';
const MODEL_NAME = RAW_MODEL_NAME || DEFAULT_MODEL;

const API_TIMEOUT = 90000; // 90秒总超时（从120s降低，防止用户等太久）
const FIRST_TOKEN_TIMEOUT = 30000; // 30秒无首token则发警告提示

function defaultBaseUrl() {
  if (API_PROVIDER === 'volcengine') return VOLCENGINE_BASE_URL;
  if (API_PROVIDER === 'aliyun') return ALIYUN_BASE_URL;
  // 自定义Key但没配URL时默认按火山引擎ARK兼容接口处理，避免误走阿里云
  return VOLCENGINE_BASE_URL;
}

function normalizeApiUrl(rawUrl) {
  const url = (rawUrl || defaultBaseUrl()).replace(/\/+$/, '');
  if (url.endsWith('/chat/completions')) {
    return {
      baseUrl: url.replace(/\/chat\/completions$/, ''),
      chatUrl: url
    };
  }
  return {
    baseUrl: url,
    chatUrl: `${url}/chat/completions`
  };
}
const { baseUrl: API_BASE_URL, chatUrl: API_CHAT_URL } = normalizeApiUrl(RAW_API_URL);
const SERVER_VERSION = 'v4.5.0-optimize-20260930';

// 健康检查和API状态端点（必须在express.static之前）
app.get('/api/health', (req, res) => {
  const apiConfigured = !!(API_KEY && API_KEY.trim().length > 0);
  res.json({ 
    status: 'ok', 
    version: SERVER_VERSION,
    uptime: process.uptime(),
    apiConfigured,
    provider: API_PROVIDER,
    model: MODEL_NAME,
    baseUrl: API_BASE_URL
  });
});

// 调试端点：生产环境需要管理员权限，开发环境开放但隐藏敏感信息
app.get('/api/debug/config', (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  const isAdmin = adminToken && adminSessions.get(adminToken) && adminSessions.get(adminToken).expires > Date.now();
  const apiConfigured = !!(API_KEY && API_KEY.trim().length > 0);
  if (isAdmin) {
    // 管理员可看详细配置
    res.json({
      version: SERVER_VERSION,
      apiConfigured,
      apiKeySource: API_KEY_SOURCE,
      provider: API_PROVIDER,
      model: MODEL_NAME,
      baseUrl: API_BASE_URL,
      keyPreview: apiConfigured ? API_KEY.substring(0, 6) + '...' + API_KEY.substring(API_KEY.length - 4) : null,
      keyLength: API_KEY ? API_KEY.length : 0,
      nodeEnv: process.env.NODE_ENV || 'development',
      nodeVersion: process.version
    });
  } else {
    // 非管理员仅能看到基本状态
    res.json({
      version: SERVER_VERSION,
      apiConfigured,
      provider: API_PROVIDER,
      model: MODEL_NAME
    });
  }
});

// 提供前端静态文件（带缓存策略）
const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // HTML文件完全不缓存，确保用户总能获取最新版本
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    // Service Worker 必须禁缓存：浏览器以24小时上限校验sw.js，缓存会导致PWA更新延迟
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ===== 简单内存缓存（热点数据）=====
const CACHE_TTL = 30 * 1000; // 30秒缓存
const cache = new Map();
function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }
function invalidateCache(key) { cache.delete(key); }
const BATCH_THRESHOLD = 24; // 流式输出批处理字符阈值
const BATCH_TIMEOUT = 30; // 流式输出批处理超时(ms)
const FIRST_PAINT_THRESHOLD = 2; // 首屏：前若干字符立即吐出，降低“迟迟不出字”的等待感

// ===== 管理员配置 =====
const ADMIN_USERNAME = process.env.YUZHOU_ADMIN || 'admin';
const ADMIN_PASSWORD = process.env.YUZHOU_ADMIN_PASS || 'admin123';
const adminSessions = new Map(); // token -> { username, expires }

// ===== 用户会话（普通用户token）=====
// token -> { username, expires }；内存存储，重启失效（前端会自动重新登录）
const userSessions = new Map();
const USER_SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

function generateToken() {
    return crypto.randomBytes(24).toString('hex');
}

function issueUserSession(username) {
    const token = generateToken();
    userSessions.set(token, { username, expires: Date.now() + USER_SESSION_TTL });
    return token;
}

// 定期清理过期会话，避免内存泄漏
setInterval(() => {
    const now = Date.now();
    for (const [t, s] of userSessions) if (s.expires < now) userSessions.delete(t);
    for (const [t, s] of adminSessions) if (s.expires < now) adminSessions.delete(t);
}, 60 * 60 * 1000).unref?.();

function generateAdminToken() {
    return crypto.randomBytes(24).toString('hex');
}

function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.adminToken;
    if (!token) return res.status(401).json({ error: '需要管理员权限' });
    const session = adminSessions.get(token);
    if (!session || session.expires < Date.now()) {
        adminSessions.delete(token);
        return res.status(401).json({ error: '管理员登录已过期，请重新登录' });
    }
    req.admin = session;
    next();
}

// 速率限制（按业务分桶：AI 生成、登录注册、其他各自独立计数，互不挤占）
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_BUCKETS = {
  ai: 10,    // AI 生成类接口（成本高、耗时长）
  auth: 15,  // 登录/注册类接口（避免生成故事时把登录额度用光）
  default: 10
};
function checkRateLimit(ip, bucket = 'default') {
    const max = RATE_LIMIT_BUCKETS[bucket] || RATE_LIMIT_BUCKETS.default;
    const key = bucket + ':' + ip;
    const now = Date.now();
    const entry = rateLimit.get(key);
    if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
        rateLimit.set(key, { start: now, count: 1 });
        return true;
    }
    entry.count++;
    return entry.count <= max;
}

// ===== 工具函数 =====
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const cleaned = String(username).replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleaned.length < 1 || cleaned.length > 30) return null;
    return cleaned;
}
// XSS 防护：转义 HTML 特殊字符，防止存储型 XSS
function sanitizeText(text, maxLen = 500) {
    if (typeof text !== 'string') return '';
    return text.slice(0, maxLen)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
function userDir(username) {
    const cleaned = sanitizeUsername(username);
    if (!cleaned) return null;
    const dir = path.join(USERS_DIR, cleaned);
    // 双保险：白名单已剔除 . / \ 等字符，此处再校验解析路径不越出用户目录
    const resolved = path.resolve(dir);
    if (resolved !== path.resolve(USERS_DIR) && !resolved.startsWith(path.resolve(USERS_DIR) + path.sep)) return null;
    return dir;
}
function userFile(username, name) {
    const dir = userDir(username);
    if (!dir) return null;
    return path.join(dir, name);
}
function readJSON(fp, d) {
    if (!fp) return d;
    try {
        assertInDataDir(fp);
        return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) {
        // ENOENT 是新用户/未初始化文件的正常状态，静默返回默认值，避免日志刷屏
        if (e.code !== 'ENOENT') console.warn('[readJSON] Error reading', fp, ':', e.message);
        return d;
    }
}
function writeJSON(fp, data) {
    if (!fp) return false;
    try {
        assertInDataDir(fp);
        const dir = path.dirname(fp);
        ensureDir(dir);
        // 原子写入：先写临时文件再rename
        const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, fp);
        return true;
    } catch (e) { console.error('[writeJSON] Error writing', fp, ':', e.message); return false; }
}

// 路径边界守卫：所有 JSON 读写必须落在 data/ 目录内，杜绝路径拼接越界
function assertInDataDir(fp) {
    const resolved = path.resolve(fp);
    const root = path.resolve(DATA_DIR);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('数据路径越界: ' + fp);
    }
}

// ===== 读改写串行化（防止并发竞态丢数据，如点赞、广场分享）=====
// 对同一文件路径的 update 操作排队执行，保证“读->改->写”原子性。
const _fileLocks = new Map(); // fp -> Promise chain tail
function updateJSON(fp, mutator, fallback) {
    if (!fp) return Promise.reject(new Error('Invalid file path'));
    const prev = _fileLocks.get(fp) || Promise.resolve();
    const next = prev.then(async () => {
        const cur = readJSON(fp, fallback);
        const updated = await mutator(cur);
        if (updated !== undefined) {
            const ok = writeJSON(fp, updated);
            if (!ok) throw new Error('写入文件失败: ' + fp);
        }
        return updated;
    }); // 不在此处 catch，让错误传播到调用方的 .catch()
    // 链尾完成后清理 Map 条目（存储 next 本身，而非 .finally() 返回的新 Promise）
    _fileLocks.set(fp, next);
    next.finally(() => { if (_fileLocks.get(fp) === next) _fileLocks.delete(fp); });
    return next;
}
// 仅当文件不存在时写入（登录时自愈补建缺失文件，绝不覆盖已有数据）
function writeJSONIfAbsent(fp, data) {
    if (!fp) return false;
    if (fs.existsSync(fp)) return true;
    return writeJSON(fp, data);
}
// 确保用户的 6 个数据文件齐全（注册/登录时调用，兼容历史用户缺文件的情况）
function ensureUserFiles(username, bio = '') {
    const udir = userDir(username);
    if (!udir) return;
    ensureDir(udir);
    writeJSONIfAbsent(userFile(username, 'history.json'), []);
    writeJSONIfAbsent(userFile(username, 'favorites.json'), []);
    writeJSONIfAbsent(userFile(username, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 });
    writeJSONIfAbsent(userFile(username, 'achievements.json'), []);
    writeJSONIfAbsent(userFile(username, 'moods.json'), []);
    writeJSONIfAbsent(userFile(username, 'profile.json'), { bio, joinDate: Date.now() });
}

// ===== 密码哈希（带 per-user 随机盐，向后兼容旧的固定盐哈希）=====// 严格模式：设为 true 后仅接受 token，彻底关闭越权。可用环境变量 YUZHOU_STRICT_AUTH=1 开启。
const STRICT_AUTH = String(process.env.YUZHOU_STRICT_AUTH || '').trim() === '1';
const LEGACY_SALT = 'yuzhou-salt';
function legacyHash(pwd) {
    return crypto.createHash('sha256').update(pwd + LEGACY_SALT).digest('hex');
}
// 新方案：scrypt + 随机盐，返回 "scrypt$salt$hash"
function hashPassword(pwd) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
    return `scrypt$${salt}$${derived}`;
}
// 校验：支持新格式与旧格式（旧用户首次登录后由调用方升级）
function verifyPassword(pwd, stored) {
    if (!stored || typeof stored !== 'string') return false;
    if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        if (!salt || !hash) return false;
        const derived = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
        } catch { return false; }
    }
    // 旧格式：固定盐 sha256
    return stored === legacyHash(pwd);
}
function needsRehash(stored) {
    return !String(stored || '').startsWith('scrypt$');
}

// 安全比较密码（防止时序攻击）
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

// 解析请求中的用户身份：优先校验 token（安全），其次兼容旧的 x-username（过渡期）
function resolveSession(req) {
    const token = req.headers['x-auth-token'] || req.query.token || null;
    if (token) {
        const s = userSessions.get(token);
        if (s && s.expires >= Date.now()) return { username: s.username, viaToken: true };
    }
    return null;
}
function getUsername(req) {
    // 1) token 优先（可信）
    const s = resolveSession(req);
    if (s) return s.username;
    // 2) 过渡兼容：允许 x-username（仅当未启用严格模式时）
    if (!STRICT_AUTH) {
        const u = req.headers['x-username'] || req.query.username || null;
        return sanitizeUsername(u);
    }
    return null;
}
function isValidStatsKey(key) {
    const allowed = ['total', 'wheelSpins', 'shares', 'collisions', 'comparisons', 'fortunes', 'yearbooks'];
    return allowed.includes(key);
}

// 用户头像生成（基于用户名的确定颜色；sha256 仅用于取色，非密码场景）
function userAvatarColor(username) {
    const hash = crypto.createHash('sha256').update(username).digest('hex');
    const h = parseInt(hash.slice(0, 6), 16) % 360;
    return { hue: h, color1: `hsl(${h}, 70%, 50%)`, color2: `hsl(${(h + 40) % 360}, 70%, 50%)` };
}

// ===== API 请求构建工具 =====
// 并发AI请求限制：防止多人同时生成导致排队雪崩
const MAX_CONCURRENT_AI = 3; // 最多同时3个AI请求
const MAX_AI_QUEUE = 10; // 最多排队10个请求，超过则拒绝
let _activeAIRequests = 0;
const _aiWaitQueue = [];
function acquireAISlot() {
  return new Promise((resolve, reject) => {
    if (_activeAIRequests < MAX_CONCURRENT_AI) { _activeAIRequests++; resolve(); return; }
    if (_aiWaitQueue.length >= MAX_AI_QUEUE) {
      reject(new Error('当前请求过多，请稍后再试'));
      return;
    }
    _aiWaitQueue.push(resolve);
  });
}
function releaseAISlot() {
  if (_aiWaitQueue.length > 0) {
    const next = _aiWaitQueue.shift();
    next(); // _activeAIRequests 不变，接力给下一个
  } else {
    _activeAIRequests = Math.max(0, _activeAIRequests - 1);
  }
}

function buildChatRequestBody(systemPrompt, userPrompt, options = {}) {
  const { temperature = 0.85, maxTokens = 8000, stream = true } = options;
  const body = {
    model: MODEL_NAME,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens: maxTokens,
    stream
  };
  // 阿里云支持response_format json_object，火山引擎不支持
  if (options.responseFormat === 'json' && API_PROVIDER === 'aliyun') {
    body.response_format = { type: 'json_object' };
  }
  // 火山引擎：关闭深度思考模式(thinking)，否则模型会先花1-2分钟"思考"
  // 思考内容不输出给用户，导致首token延迟极长，体验为"长时间空白后突然快速出字"
  if (API_PROVIDER === 'volcengine') {
    body.thinking = { type: 'disabled' };
  }
  // DashScope（千问平台）：deepseek-v4.1 等模型默认开启思考模式，
  // 推理内容以 reasoning_content 流出（前端不展示），首token延迟可达45秒，
  // 且思考token会挤占 max_tokens 导致 finish_reason=length 故事截断
  if (API_PROVIDER === 'aliyun') {
    body.enable_thinking = false;
  }
  return body;
}

function safeJsonParse(text, fallback = null) {
  if (!text || typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 尝试清理常见的markdown代码块包装
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/^```\s*/i, '')
      .trim();
    if (cleaned !== text) {
      try {
        return JSON.parse(cleaned);
      } catch (e2) {
        // 忽略
      }
    }
    return fallback;
  }
}

function formatApiError(status, statusText, provider) {
  const providerName = provider === 'volcengine' ? '火山引擎' : provider === 'aliyun' ? '阿里云' : 'API';
  if (status === 401) return `${providerName} API Key无效或已过期，请检查环境变量配置`;
  if (status === 429) return `${providerName} API请求过于频繁，请稍后再试`;
  if (status >= 500) return `${providerName} 服务端暂时不可用 (${status})，请稍后重试`;
  return `${providerName} API调用失败: HTTP ${status} ${statusText}`;
}

// ===== SSE 流式生成工具（DRY：消除 generate-stream / collide / continue 的重复代码）=====
// 统一处理：SSE头、心跳、首token超时、并发控制、批处理、断连清理、错误兜底
async function createSSEStream(req, res, opts) {
  const {
    systemPrompt, userPrompt,
    temperature = 0.85, maxTokens = 2500,
    tag = 'Stream'
  } = opts;

  // --- SSE 头 ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // --- 连接状态 ---
  let clientDisconnected = false;
  let controller = null;
  let batchTimer = null;
  let reader = null;
  let apiTimer = null;
  let streamEndedNormally = false;
  let heartbeat = null;
  let firstTokenWarnTimer = null;

  // 统一定时器清理：无论正常结束还是异常断开，都清除所有定时器
  const clearAllTimers = () => {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (apiTimer) { clearTimeout(apiTimer); apiTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (firstTokenWarnTimer) { clearTimeout(firstTokenWarnTimer); firstTokenWarnTimer = null; }
  };
  const safeEnd = () => {
    if (!res.writableEnded) {
      streamEndedNormally = true;
      clearAllTimers();
      res.end();
    }
  };
  const cleanup = () => {
    if (streamEndedNormally) return;
    clientDisconnected = true;
    clearAllTimers();
    if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
    // reader.cancel() 返回 Promise：流已 abort 时会以 AbortError reject，
    // 必须接住，否则产生 UNHANDLED REJECTION 噪音
    if (reader) { try { reader.cancel().catch(() => {}); } catch (_) {} reader = null; }
  };
  req.on('aborted', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('close', () => { if (!res.writableEnded && !streamEndedNormally) cleanup(); });

  // --- 连接确认 ---
  res.write(`data: ${JSON.stringify({ connected: true, timestamp: Date.now() })}\n\n`);

  // --- 心跳 ---
  heartbeat = setInterval(() => {
    if (!res.writableEnded && !streamEndedNormally) {
      try { res.write(`: heartbeat\n\n`); } catch (_) {}
    }
  }, 15000);

  // --- 首token超时提示 ---
  firstTokenWarnTimer = setTimeout(() => {
    if (!streamEndedNormally && !clientDisconnected && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ status: 'slow', msg: 'AI正在深度思考中，请耐心等待...' })}\n\n`);
    }
  }, FIRST_TOKEN_TIMEOUT);

  const t0 = Date.now();
  console.log(`[${tag}] Request received`);

  // --- API Key 检查 ---
  if (!API_KEY || API_KEY.trim().length === 0) {
    console.log(`[${tag}] API_KEY not configured`);
    streamEndedNormally = true;
    res.write(`data: ${JSON.stringify({ error: 'API_KEY 未配置，请联系管理员' })}\n\n`);
    res.write(`event: done\ndata: [DONE]\n\n`);
    safeEnd();
    return;
  }

  let slotAcquired = false;
  try {
    await acquireAISlot();
    slotAcquired = true;
    if (clientDisconnected) { return; } // 排队期间客户端已断开，直接释放槽位
    controller = new AbortController();
    apiTimer = setTimeout(() => {
      console.error(`[${tag}] Timeout after ${API_TIMEOUT}ms`);
      const c = controller;
      if (c) { try { c.abort(); } catch (_) {} }
    }, API_TIMEOUT);

    console.log(`[${tag}] Calling API...`, API_PROVIDER, MODEL_NAME);

    const response = await fetch(API_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify(buildChatRequestBody(systemPrompt, userPrompt, { temperature, maxTokens, stream: true })),
      signal: controller.signal
    });
    clearTimeout(apiTimer); apiTimer = null;
    if (clientDisconnected) { try { response.body?.cancel(); } catch (_) {} return; }
    console.log(`[${tag}] API responded in ${Date.now() - t0}ms, status: ${response.status}`);

    if (!response.ok) {
      let errText = '';
      try { errText = await response.text(); } catch (_) {}
      console.error(`[${tag}] API error:`, response.status, errText.slice(0, 500));
      let errMsg = formatApiError(response.status, response.statusText, API_PROVIDER);
      const errJson = safeJsonParse(errText);
      if (errJson && (errJson.error?.message || errJson.message)) {
        errMsg = errJson.error?.message || errJson.message;
      } else if (errText) {
        errMsg = errText.slice(0, 200);
      }
      streamEndedNormally = true;
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write(`event: done\ndata: [DONE]\n\n`);
      safeEnd();
      return;
    }

    // --- 流式读取 ---
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstToken = true;
    let firstPaintDone = false;
    let batchContent = '';

    const flushBatch = () => {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      if (batchContent && !clientDisconnected && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: batchContent })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
        batchContent = '';
      }
    };

    while (!clientDisconnected) {
      let readResult;
      try { readResult = await reader.read(); }
      catch (readErr) { if (clientDisconnected) break; throw readErr; }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let dataStr = null;
        if (t.startsWith('data:')) dataStr = t.slice(5).trim();
        if (dataStr === null) continue;

        if (dataStr === '[DONE]') {
          flushBatch();
          console.log(`[${tag}] Completed in ${Date.now() - t0}ms`);
          streamEndedNormally = true;
          res.write(`event: done\ndata: [DONE]\n\n`);
          safeEnd();
          return;
        }
        try {
          const p = JSON.parse(dataStr);
          // 记录 finish_reason，诊断 AI 提前停止的原因
          const fr = p.choices?.[0]?.finish_reason || p.output?.choices?.[0]?.finish_reason;
          if (fr) console.log(`[${tag}] finish_reason: ${fr}`);
          let c = '';
          if (p.choices?.[0]?.delta?.content) c = p.choices[0].delta.content;
          else if (p.choices?.[0]?.message?.content) c = p.choices[0].message.content;
          else if (p.output?.choices?.[0]?.message?.content) c = p.output.choices[0].message.content;
          else if (p.output?.text) c = p.output.text;
          if (c) {
            if (firstToken) {
              console.log(`[${tag}] First token in ${Date.now() - t0}ms`);
              firstToken = false;
              if (firstTokenWarnTimer) { clearTimeout(firstTokenWarnTimer); firstTokenWarnTimer = null; }
            }
            batchContent += c;
            if (!firstPaintDone && batchContent.length >= FIRST_PAINT_THRESHOLD) {
              flushBatch(); firstPaintDone = true;
            } else if (batchContent.length >= BATCH_THRESHOLD) {
              flushBatch();
            } else if (!batchTimer) {
              batchTimer = setTimeout(flushBatch, BATCH_TIMEOUT);
            }
          }
        } catch (e) {
          if (dataStr.length < 200) console.warn(`[${tag}] JSON parse error:`, dataStr, e.message);
          else console.warn(`[${tag}] JSON parse error (truncated):`, dataStr.slice(0, 100) + '...', e.message);
        }
      }
    }
    flushBatch();
    if (!clientDisconnected && !res.writableEnded) {
      console.log(`[${tag}] Completed in ${Date.now() - t0}ms`);
      streamEndedNormally = true;
      res.write(`event: done\ndata: [DONE]\n\n`);
      safeEnd();
    }
  } catch (e) {
    clearAllTimers();
    if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
    if (e.name === 'AbortError' && clientDisconnected) {
      console.log(`[${tag}] Client disconnected, aborted`);
      safeEnd();
      return;
    }
    console.error(`[${tag}] Error:`, e.name, e.message);
    console.error(`[${tag}] Stack:`, e.stack?.split('\n')?.slice(0, 3)?.join('\n'));
    if (!res.writableEnded) {
      // 友好的错误消息
      let errMsg = e.message || '未知错误';
      if (e.name === 'AbortError') errMsg = 'AI 响应超时，请重试';
      else if (e.message === '当前请求过多，请稍后再试') errMsg = e.message;
      streamEndedNormally = true;
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write(`event: done\ndata: [DONE]\n\n`);
      safeEnd();
    }
  } finally {
    if (slotAcquired) releaseAISlot();
  }
}

// ===== 系统提示词（为 deepseek-v4.1 级别强模型调优：重文学质量）=====
// 注意：JSON schema 是前端解析契约（normalizeData），字段名不可改动
const SYSTEM_PROMPT = `你是"平行宇宙叙事生成器"：用户给出一个人生假设，你为他书写那条没有走的路。

只输出纯JSON（第一个字符必须是{，最后一个字符必须是}，不要任何解释、代码块标记或前后缀），结构如下：
{"universe":"宇宙名","story":[{"time":"时间","title":"标题","text":"叙事"},...共5个],"fragments":[{"emoji":"emoji","text":"描述","size":"large/small"},...共4个],"letter":{"greeting":"称呼","paragraphs":["段1","段2","段3","段4"],"signature":"另一个宇宙的你","stamp":"平行宇宙认证"}}

创作要求：
1. universe：3-8字，有诗意、能点题，如"轨道回声宇宙""檐下风铃宇宙"
2. story：5个场景构成完整人生弧线（起因→展开→转折→代价与收获→回望），相邻场景因果承接。每场景120-200字，以具体时间开头（如"2014年9月"），落到地点与感官细节（光线、声音、气味），每场至少一句对话——对话一律用中文引号""
3. 写出"选择的真实感"：另一条路同样有代价与遗憾，不是童话；最后一个场景回望最初的选择，形成首尾呼应
4. fragments：4个碎片，每条15-50字，必须是故事中出现过的具体物品或瞬间（不要泛泛抒情），size至少1个large
5. letter：以那条时间线上的"你"写给现实中的"你"，4段，情感递进——见证他/她的日子→回应故事中一个具体细节→坦然承认遗憾→给出宽慰与祝福
6. 全文简体中文；字符串内不要出现英文双引号，引用英文时用单引号`;

// ===== 用户系统 =====
app.post('/api/auth/register', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'auth')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || username.length > 20 || password.length < 4)
    return res.status(400).json({ error: '用户名2-20字，密码至少4位' });
  if (username !== username.replace(/[^a-zA-Z0-9_-]/g, ''))
    return res.status(400).json({ error: '用户名只能包含字母数字下划线' });

  ensureDir(USERS_DIR);
  const usersFile = path.join(DATA_DIR, 'users.json');
  
  let existed = false; // 闭包标志：mutator 在串行队列内同步置位，杜绝同毫秒误判
  updateJSON(usersFile, (users) => {
    const obj = users && typeof users === 'object' ? users : {};
    if (obj[username]) { existed = true; return obj; }
    const avatar = userAvatarColor(username);
    obj[username] = { password: hashPassword(password), created: Date.now(), avatar };
    return obj;
  }, {}).then((users) => {
    if (existed) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    // 初始化用户数据文件
    ensureUserFiles(username);

    const token = issueUserSession(username);
    res.json({ ok: true, username, avatar: users[username].avatar, token });
  }).catch(err => {
    console.error('[Auth] Register error:', err);
    if (!res.headersSent) res.status(500).json({ error: '注册失败，请重试' });
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'auth')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  
  // 检查是否是管理员登录
  const isAdmin = safeCompare(username, ADMIN_USERNAME) && safeCompare(password, ADMIN_PASSWORD);
  
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const user = users[username];
  
  // 管理员登录：如果admin用户不存在，自动创建
  if (isAdmin) {
    if (!users[username]) {
      const avatar = userAvatarColor(username);
      updateJSON(path.join(DATA_DIR, 'users.json'), (obj) => {
        const o = obj && typeof obj === 'object' ? obj : {};
        if (!o[username]) o[username] = { password: hashPassword(password), created: Date.now(), avatar };
        return o;
      }, {}).catch(() => {});
      ensureUserFiles(username, '管理员');
    }
    // 生成admin token
    const token = generateAdminToken();
    adminSessions.set(token, { username, expires: Date.now() + 2 * 60 * 60 * 1000 });
    const userToken = issueUserSession(username);
    console.log('[Admin] Login via user auth:', username);
    return res.json({ ok: true, username, avatar: users[username].avatar, isAdmin: true, adminToken: token, token: userToken });
  }
  
  // 普通用户登录验证
  if (!user || !verifyPassword(password, user.password))
    return res.status(401).json({ error: '用户名或密码错误' });
  // 自愈：补建历史用户缺失的数据文件（不覆盖已有数据）
  ensureUserFiles(username);
  // 旧格式密码登录成功后自动升级为 scrypt 强哈希
  if (needsRehash(user.password)) {
    updateJSON(path.join(DATA_DIR, 'users.json'), (users) => {
      const obj = users && typeof users === 'object' ? users : {};
      if (obj[username]) obj[username].password = hashPassword(password);
      return obj;
    }, {}).then(() => {
      console.log('[Auth] Upgraded password hash for', username);
    }).catch(err => {
      console.error('[Auth] Failed to upgrade hash for', username, err);
    });
  }
  const token = issueUserSession(username);
  res.json({ ok: true, username, avatar: user.avatar, isAdmin: false, token });
});

// 退出登录：使当前 token 失效
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'] || (req.body || {}).token || req.query.token;
  if (token) userSessions.delete(token);
  res.json({ ok: true });
});

// ===== 用户画像 API =====
app.get('/api/profile', (req, res) => {
  const username = getUsername(req);
  if (!username) return res.status(401).json({ error: '请先登录' });
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const user = users[username];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const profile = readJSON(userFile(username, 'profile.json'), { bio: '', joinDate: user.created });
  const stats = readJSON(userFile(username, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 });
  const achievements = readJSON(userFile(username, 'achievements.json'), []);
  const history = readJSON(userFile(username, 'history.json'), []);
  const favorites = readJSON(userFile(username, 'favorites.json'), []);
  res.json({
    username,
    avatar: user.avatar,
    created: user.created,
    bio: profile.bio || '',
    stats,
    achievementCount: achievements.length,
    historyCount: history.length,
    favoritesCount: favorites.length
  });
});

app.post('/api/profile', (req, res) => {
  const username = getUsername(req);
  if (!username) return res.status(400).json({ error: '请先登录' });
  const { bio } = req.body || {};
  const fp = userFile(username, 'profile.json');
  updateJSON(fp, (profile) => {
    const p = profile && typeof profile === 'object' ? profile : {};
    if (bio !== undefined) p.bio = sanitizeText(bio, 200);
    return p;
  }, {}).then((profile) => {
    res.json({ ok: true, profile });
  }).catch(err => {
    console.error('[Profile] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});

// ===== SSE 流式生成 =====
app.post('/api/generate-stream', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length === 0 || query.length > 100)
    return res.status(400).json({ error: '请输入有效的人生假设（1-100字）' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'ai')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });

  await createSSEStream(req, res, {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: query,
    temperature: 0.85,
    maxTokens: 6000,
    tag: 'Stream'
  });
});

// ===== 用户数据 API =====
app.get('/api/history', (req, res) => {
  const u = getUsername(req);
  res.json(u ? readJSON(userFile(u, 'history.json'), []) : readJSON(path.join(DATA_DIR, 'history.json'), []));
});
app.post('/api/history', (req, res) => {
  const u = getUsername(req);
  const { query, content, universeId, timestamp, time } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const fp = u ? userFile(u, 'history.json') : path.join(DATA_DIR, 'history.json');
  updateJSON(fp, (history) => {
    const list = Array.isArray(history) ? history : [];
    const idx = list.findIndex(h => h.query === query);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift({ query, content: content || null, universeId: universeId || '', timestamp: timestamp || time || Date.now() });
    if (list.length > 50) list.length = 50;
    return list;
  }, []).then((list) => {
    if (query) updateTrending(query);
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[History] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});
app.delete('/api/history', (req, res) => {
  const u = getUsername(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fp = userFile(u, 'history.json');
  if (req.query.clear === 'all') {
    updateJSON(fp, () => [], []).then(() => {
      res.json({ ok: true, total: 0 });
    }).catch(err => {
      console.error('[History] Clear error:', err);
      if (!res.headersSent) res.status(500).json({ error: '清除失败' });
    });
    return;
  }
  const { index } = req.body || {};
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
  updateJSON(fp, (history) => {
    const list = Array.isArray(history) ? history : [];
    if (idx < list.length) list.splice(idx, 1);
    return list;
  }, []).then((list) => {
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[History] Delete error:', err);
    if (!res.headersSent) res.status(500).json({ error: '删除失败' });
  });
});

app.get('/api/favorites', (req, res) => {
  const u = getUsername(req);
  res.json(u ? readJSON(userFile(u, 'favorites.json'), []) : readJSON(path.join(DATA_DIR, 'favorites.json'), []));
});
app.post('/api/favorites', (req, res) => {
  const u = getUsername(req);
  const { query, content, universeId, timestamp } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const fp = u ? userFile(u, 'favorites.json') : path.join(DATA_DIR, 'favorites.json');
  updateJSON(fp, (favs) => {
    const list = Array.isArray(favs) ? favs : [];
    if (list.find(f => f.query === query)) return list; // 已存在，不重复添加
    list.unshift({ query, content: content || null, universeId: universeId || '', timestamp: timestamp || Date.now() });
    if (list.length > 50) list.length = 50;
    return list;
  }, []).then((list) => {
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[Favorites] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});
app.delete('/api/favorites', (req, res) => {
  const u = getUsername(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fp = userFile(u, 'favorites.json');
  const { index } = req.body || {};
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
  updateJSON(fp, (favs) => {
    const list = Array.isArray(favs) ? favs : [];
    if (idx < list.length) list.splice(idx, 1);
    return list;
  }, []).then((list) => {
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[Favorites] Delete error:', err);
    if (!res.headersSent) res.status(500).json({ error: '删除失败' });
  });
});

app.get('/api/stats', (req, res) => {
  const u = getUsername(req);
  res.json(u ? readJSON(userFile(u, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 }) : readJSON(path.join(DATA_DIR, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 }));
});
app.post('/api/stats', (req, res) => {
  const u = getUsername(req);
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string' || !isValidStatsKey(key)) return res.status(400).json({ error: 'Invalid stats key' });
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) return res.status(400).json({ error: 'Invalid stats value' });
  const fp = u ? userFile(u, 'stats.json') : path.join(DATA_DIR, 'stats.json');
  updateJSON(fp, (stats) => {
    const s = stats && typeof stats === 'object' ? stats : { total: 0, wheelSpins: 0, shares: 0 };
    if (value !== undefined) s[key] = value; else s[key] = (typeof s[key] === 'number' ? s[key] : 0) + 1;
    return s;
  }, { total: 0, wheelSpins: 0, shares: 0 }).then((stats) => {
    res.json({ ok: true, stats });
  }).catch(err => {
    console.error('[Stats] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});

app.get('/api/achievements', (req, res) => {
  const u = getUsername(req);
  res.json(u ? readJSON(userFile(u, 'achievements.json'), []) : readJSON(path.join(DATA_DIR, 'achievements.json'), []));
});
app.post('/api/achievements/:id', (req, res) => {
  const u = getUsername(req);
  const fp = u ? userFile(u, 'achievements.json') : path.join(DATA_DIR, 'achievements.json');
  updateJSON(fp, (achievements) => {
    const list = Array.isArray(achievements) ? achievements : [];
    if (!list.includes(req.params.id)) list.push(req.params.id);
    return list;
  }, []).then((list) => {
    res.json({ ok: true, achievements: list || [] });
  }).catch(err => {
    console.error('[Achievements] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});

app.get('/api/moods', (req, res) => {
  const u = getUsername(req);
  res.json(u ? readJSON(userFile(u, 'moods.json'), []) : readJSON(path.join(DATA_DIR, 'moods.json'), []));
});
app.post('/api/moods', (req, res) => {
  const u = getUsername(req);
  const { mood, timestamp } = req.body || {};
  const moodNum = Number(mood);
  if (!Number.isFinite(moodNum) || moodNum < 1 || moodNum > 5) return res.status(400).json({ error: 'Invalid mood' });
  const fp = u ? userFile(u, 'moods.json') : path.join(DATA_DIR, 'moods.json');
  updateJSON(fp, (moods) => {
    const list = Array.isArray(moods) ? moods : [];
    list.push({ mood: moodNum, timestamp: timestamp || Date.now() });
    if (list.length > 200) list.splice(0, list.length - 200);
    return list;
  }, []).then((list) => {
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[Moods] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '保存失败' });
  });
});

app.get('/api/sync', (req, res) => {
  const u = getUsername(req);
  if (!u) return res.json({
    history: readJSON(path.join(DATA_DIR, 'history.json'), []),
    favorites: readJSON(path.join(DATA_DIR, 'favorites.json'), []),
    stats: readJSON(path.join(DATA_DIR, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 }),
    achievements: readJSON(path.join(DATA_DIR, 'achievements.json'), []),
    moods: readJSON(path.join(DATA_DIR, 'moods.json'), [])
  });
  res.json({
    history: readJSON(userFile(u, 'history.json'), []),
    favorites: readJSON(userFile(u, 'favorites.json'), []),
    stats: readJSON(userFile(u, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 }),
    achievements: readJSON(userFile(u, 'achievements.json'), []),
    moods: readJSON(userFile(u, 'moods.json'), [])
  });
});

// ===== 探索广场（共享功能）=====
// 公开分享探索
ensureDir(SHARED_DIR);
app.post('/api/square/share', (req, res) => {
  const u = getUsername(req);
  if (!u) return res.status(400).json({ error: '请先登录' });
  const { query, universe, excerpt, storyPreview, content } = req.body || {};
  if (!query || !universe) return res.status(400).json({ error: 'Missing data' });
  // 限制 content 大小，防止存储膨胀
  let safeContent = content || null;
  if (safeContent && JSON.stringify(safeContent).length > 10000) safeContent = null;
  const sharedFp = path.join(SHARED_DIR, 'shared.json');
  updateJSON(sharedFp, (shared) => {
    const list = Array.isArray(shared) ? shared : [];
    // 去重
    const idx = list.findIndex(s => s.query === query && s.username === u);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift({
      id: crypto.randomBytes(6).toString('hex'),
      username: u,
      query: sanitizeText(query, 100),
      universe: sanitizeText(universe, 50),
      excerpt: sanitizeText(excerpt || '', 200),
      storyPreview: sanitizeText(storyPreview || '', 300),
      content: safeContent,
      timestamp: Date.now(),
      likes: 0,
      commentCount: 0
    });
    if (list.length > 200) list.length = 200;
    return list;
  }, []).then((list) => {
    invalidateCache('square-list');
    res.json({ ok: true, total: list ? list.length : 0 });
  }).catch(err => {
    console.error('[Square] Share error:', err);
    if (!res.headersSent) res.status(500).json({ error: '分享失败，请重试' });
  });
});

// 获取广场内容（带缓存优化）
app.get('/api/square', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 50));
    // 第一页使用缓存，翻页不缓存保证数据新鲜度
    const cacheKey = page === 1 ? 'square-list' : null;
    if (cacheKey) {
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);
    }
    const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
    const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
    // 附加用户头像和评论数
    const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
    const enriched = shared.map(s => {
        // 从content中提取元数据用于卡片预览，但不返回完整内容
        let storyCount = 0;
        let fragmentCount = 0;
        let hasLetter = false;
        let previewStages = [];
        if (s.content) {
            storyCount = Array.isArray(s.content.story) ? s.content.story.length : 0;
            fragmentCount = Array.isArray(s.content.fragments) ? s.content.fragments.length : 0;
            hasLetter = !!(s.content.letter && (s.content.letter.paragraphs || s.content.letter.greeting));
            // 提取时间点预览（最多3个）
            if (Array.isArray(s.content.story)) {
                previewStages = s.content.story.slice(0, 3).map(st => st.time || '').filter(t => t);
            }
        }
        return {
            ...s,
            content: undefined, // 列表不返回完整内容
            avatar: (users[s.username] && users[s.username].avatar) || userAvatarColor(s.username),
            commentCount: (comments[s.id] || []).length,
            storyCount,
            fragmentCount,
            hasLetter,
            previewStages
        };
    });
    const start = (page - 1) * limit;
    const result = {
        items: enriched.slice(start, start + limit),
        total: enriched.length,
        page,
        hasMore: start + limit < enriched.length
    };
    if (cacheKey) setCached(cacheKey, result);
    res.json(result);
});

// 获取单个分享详情（含完整内容）
app.get('/api/square/:id', (req, res) => {
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const item = shared.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  res.json({
    ...item,
    avatar: (users[item.username] && users[item.username].avatar) || userAvatarColor(item.username),
    commentCount: (comments[item.id] || []).length
  });
});

// ===== 评论系统 =====
// 获取某条分享的评论
app.get('/api/square/:id/comments', (req, res) => {
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  const list = comments[req.params.id] || [];
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  // 附加头像
  const enriched = list.map(c => ({
    ...c,
    avatar: (users[c.username] && users[c.username].avatar) || userAvatarColor(c.username)
  }));
  res.json({ comments: enriched });
});

// 发表评论（使用 updateJSON 串行化，防止并发数据丢失）
app.post('/api/square/:id/comments', (req, res) => {
  const u = getUsername(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }
  if (text.length > 200) return res.status(400).json({ error: '评论不能超过200字' });

  const postId = req.params.id;
  const commentsFile = path.join(SHARED_DIR, 'comments.json');
  const sharedFile = path.join(SHARED_DIR, 'shared.json');

  // 先检查帖子是否存在
  const shared = readJSON(sharedFile, []);
  const item = shared.find(s => s.id === postId);
  if (!item) return res.status(404).json({ error: '分享不存在' });

  // XSS 防护：转义评论内容
  const comment = {
    id: crypto.randomBytes(4).toString('hex'),
    username: u,
    text: sanitizeText(text.trim(), 200),
    timestamp: Date.now()
  };

  // 串行化更新 comments.json
  updateJSON(commentsFile, (comments) => {
    const obj = comments && typeof comments === 'object' ? comments : {};
    if (!Array.isArray(obj[postId])) obj[postId] = [];
    obj[postId].push(comment);
    return obj;
  }, {}).then((commentsObj) => {
    // 串行化更新 shared.json 的 commentCount
    return updateJSON(sharedFile, (sharedList) => {
      const list = Array.isArray(sharedList) ? sharedList : [];
      const it = list.find(s => s.id === postId);
      if (it) it.commentCount = (commentsObj[postId] || []).length;
      return list;
    }, []);
  }).then(() => {
    invalidateCache('square-list');
    const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
    res.json({
      ok: true,
      comment: {
        ...comment,
        avatar: (users[u] && users[u].avatar) || userAvatarColor(u)
      }
    });
  }).catch(err => {
    console.error('[Comments] Save error:', err);
    if (!res.headersSent) res.status(500).json({ error: '评论失败，请重试' });
  });
});

// 点赞（基于IP简单去重，24小时内同一IP不能重复点赞同一帖子）
const likeTracker = new Map(); // id+ip -> timestamp
app.post('/api/square/like/:id', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const likeKey = req.params.id + ':' + ip;
  const now = Date.now();
  const lastLike = likeTracker.get(likeKey);
  if (lastLike && now - lastLike < 24 * 60 * 60 * 1000) {
    return res.status(429).json({ error: '你已经赞过了', liked: true });
  }
  likeTracker.set(likeKey, now);
  const sharedFp = path.join(SHARED_DIR, 'shared.json');
  let resultLikes = null, notFound = false;
  updateJSON(sharedFp, (shared) => {
    const list = Array.isArray(shared) ? shared : [];
    const item = list.find(s => s.id === req.params.id);
    if (!item) { notFound = true; return undefined; } // 不写回
    item.likes = (item.likes || 0) + 1;
    resultLikes = item.likes;
    return list;
  }, []).then(() => {
    if (notFound) {
      likeTracker.delete(likeKey); // 回滚，允许重试
      return res.status(404).json({ error: '帖子不存在' });
    }
    invalidateCache('square-list');
    res.json({ ok: true, likes: resultLikes });
  }).catch(err => {
    console.error('[Square] Like error:', err);
    likeTracker.delete(likeKey);
    if (!res.headersSent) res.status(500).json({ error: '操作失败，请重试' });
  });
});

// ===== 排行榜（共享功能）=====
app.get('/api/leaderboard', (req, res) => {
  const cached = getCached('leaderboard');
  if (cached) return res.json(cached);
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const leaderboard = Object.entries(users).map(([username, data]) => {
    const udir = userDir(username);
    if (!udir) return null;
    const stats = readJSON(path.join(udir, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 });
    const achievements = readJSON(path.join(udir, 'achievements.json'), []);
    const history = readJSON(path.join(udir, 'history.json'), []);
    const favorites = readJSON(path.join(udir, 'favorites.json'), []);
    return {
      username,
      avatar: data.avatar || userAvatarColor(username),
      totalExplores: stats.total || history.length,
      achievements: achievements.length,
      favorites: favorites.length,
      score: (stats.total || history.length) * 10 + achievements.length * 50 + favorites.length * 20
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 20);
  setCached('leaderboard', leaderboard);
  res.json(leaderboard);
});

// ===== 热门话题（共享功能）=====
const trendingFile = path.join(SHARED_DIR, 'trending.json');
function updateTrending(query) {
  if (!query || typeof query !== 'string') return;
  const key = query.slice(0, 60);
  updateJSON(trendingFile, (trending) => {
    const obj = trending && typeof trending === 'object' ? trending : {};
    obj[key] = (typeof obj[key] === 'number' ? obj[key] : 0) + 1;
    // 只保留前100
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 100);
    return Object.fromEntries(entries);
  }, {}).catch(err => {
    console.error('[Trending] Update error:', err);
  });
}

app.get('/api/trending', (req, res) => {
  const trending = readJSON(trendingFile, {});
  const entries = Object.entries(trending).sort((a, b) => b[1] - a[1]).slice(0, 12);
  res.json(entries.map(([query, count]) => ({ query, count })));
});

// ===== 全站统计 =====
app.get('/api/global-stats', (req, res) => {
  const cached = getCached('global-stats');
  if (cached) return res.json(cached);
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const userList = Object.keys(users);
  let totalExplores = 0, totalFavorites = 0;
  const now = Date.now();
  userList.forEach(u => {
    const udir = userDir(u);
    if (!udir) return;
    totalExplores += readJSON(path.join(udir, 'history.json'), []).length;
    totalFavorites += readJSON(path.join(udir, 'favorites.json'), []).length;
  });
  totalExplores += readJSON(path.join(DATA_DIR, 'history.json'), []).length;
  totalFavorites += readJSON(path.join(DATA_DIR, 'favorites.json'), []).length;
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []).length;
  // 统计今日活跃用户（24小时内有活动的用户）
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let activeToday = 0;
  userList.forEach(u => {
    const udir = userDir(u);
    if (!udir) return;
    const hist = readJSON(path.join(udir, 'history.json'), []);
    if (hist.some(h => h.timestamp > dayAgo)) activeToday++;
  });
  const result = { userCount: userList.length, totalExplores, totalFavorites, sharedUniverses: shared, activeToday };
  setCached('global-stats', result);
  res.json(result);
});

// ===== 宇宙碰撞（融合两个宇宙）=====
const COLLIDE_PROMPT = `你是"平行宇宙碰撞叙事生成器"：两条不同的人生时间线在某个节点交汇，你书写它们碰撞融合后的新故事。

只输出纯JSON（第一个字符必须是{，最后一个字符必须是}，不要任何解释或代码块标记），结构如下：
{"universe":"碰撞宇宙名","preamble":"开场白","story":[{"time":"时间","title":"标题","text":"叙事"},...共3个],"conclusion":"结局感悟","stamp":"宇宙碰撞认证"}

创作要求：
1. preamble：60-100字，写出两个宇宙初次交汇的那个瞬间，要有画面感
2. story：3个场景，每个150-200字，两条时间线的主人公在碰撞中互相冲击、互相改变——观念冲突要具体（习惯、价值观、说话方式），融合后的新世界要自洽
3. conclusion：60-100字，收束碰撞后的世界，点出"两个选择并不对立"或"差异本身是礼物"一类感悟，避免说教腔
4. 对话一律用中文引号""；全文简体中文；字符串内不要出现英文双引号`;

app.post('/api/collide', async (req, res) => {
  const { queryA, queryB } = req.body || {};
  if (!queryA || !queryB || typeof queryA !== 'string' || typeof queryB !== 'string')
    return res.status(400).json({ error: 'Invalid queries' });
  if (queryA.trim().length === 0 || queryB.trim().length === 0)
    return res.status(400).json({ error: '查询内容不能为空' });
  if (queryA.length > 100 || queryB.length > 100)
    return res.status(400).json({ error: '查询内容过长' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'ai')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });

  const userMsg = `第一个宇宙：${queryA}\n第二个宇宙：${queryB}\n请生成这两个宇宙碰撞融合后的故事。`;
  await createSSEStream(req, res, {
    systemPrompt: COLLIDE_PROMPT,
    userPrompt: userMsg,
    temperature: 0.9,
    maxTokens: 4500,
    tag: 'Collide'
  });
});

// ===== AI 续写故事（专用 SSE 端点）=====
const CONTINUE_PROMPT = `你是平行宇宙故事续写器。接续给定的故事，续写接下来发生的一到两个场景。

要求：
1. 直接输出叙事正文（不要JSON、不要标题、不要任何前后缀）
2. 200-350字，延续既有文风、人称与时间线，至少一句对话（用中文引号""）
3. 给情节一个小推进或小转折，不复述已有内容，不写成总结
4. 全文简体中文`;

app.post('/api/continue-stream', async (req, res) => {
  const { query, story } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length === 0)
    return res.status(400).json({ error: '缺少故事上下文' });
  if (query.length > 2000)
    return res.status(400).json({ error: '上下文过长' });
  // 限制 story 数组大小，防止构造超长 prompt
  const safeStory = Array.isArray(story) ? story.slice(-5) : [];
  const storyText = safeStory.map(s => `${s.time || ''} - ${s.title || ''}: ${(s.text || '').slice(0, 500)}`).join('\n');
  if (storyText.length > 3000)
    return res.status(400).json({ error: '故事内容过长' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'ai')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });

  const context = `原故事假设：${query}\n已有故事：\n${storyText}\n\n请续写接下来发生的事情。`;
  await createSSEStream(req, res, {
    systemPrompt: CONTINUE_PROMPT,
    userPrompt: context,
    temperature: 0.9,
    maxTokens: 800,
    tag: 'Continue'
  });
});

// ===== 每日挑战 =====
const DAILY_CHALLENGES = [
  { id: 'career', icon: '&#128188;', title: '职业抉择', desc: '如果你选择了完全不同的职业道路', hint: '试试：如果我当初选择了成为画家' },
  { id: 'love', icon: '&#128150;', title: '爱情岔路', desc: '如果你在爱情中做了不同的选择', hint: '试试：如果我没有在那天提出分手' },
  { id: 'city', icon: '&#127961;', title: '城市漂流', desc: '如果你去了另一座城市生活', hint: '试试：如果我留在了北京没有回老家' },
  { id: 'study', icon: '&#127891;', title: '学业转折', desc: '如果你学了完全不同的专业', hint: '试试：如果我当初选了哲学而不是计算机' },
  { id: 'friend', icon: '&#129309;', title: '友谊十字路', desc: '如果你和某个朋友没有走散', hint: '试试：如果我和小学最好的朋友一直保持联系' },
  { id: 'health', icon: '&#127807;', title: '健康觉醒', desc: '如果你更早开始关注健康', hint: '试试：如果我十年前就开始坚持跑步' },
  { id: 'hobby', icon: '&#127912;', title: '热爱追寻', desc: '如果你坚持了某个放弃的爱好', hint: '试试：如果我一直坚持弹钢琴到现在' },
  { id: 'brave', icon: '&#128170;', title: '勇气时刻', desc: '如果你在关键时刻更勇敢一些', hint: '试试：如果当时我勇敢地表白了' },
  { id: 'family', icon: '&#128104;', title: '家庭羁绊', desc: '如果你在家庭中做了不同选择', hint: '试试：如果我选择留在父母身边工作' },
  { id: 'travel', icon: '&#9992;', title: '旅途变奏', desc: '如果某次旅行改变了方向', hint: '试试：如果那次旅行我没有取消' },
  { id: 'money', icon: '&#128176;', title: '财富抉择', desc: '如果你做出了不同的财务决定', hint: '试试：如果我当年买了那套房子' },
  { id: 'dream', icon: '&#127775;', title: '梦想追寻', desc: '如果你追逐了看似不可能的梦想', hint: '试试：如果我坚持了音乐梦想没有放弃' }
];

app.get('/api/daily-challenge', (req, res) => {
  const today = new Date();
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  const challenge = DAILY_CHALLENGES[dayOfYear % DAILY_CHALLENGES.length];
  res.json({
    ...challenge,
    date: today.toISOString().slice(0, 10),
    dayOfYear
  });
});

// ===== 随机话题 =====
const RANDOM_TOPICS = [
  '如果我当初选择了另一所大学', '如果我没有学会编程', '如果我成为了一名厨师',
  '如果我留在了故乡没有离开', '如果我没有错过那次航班', '如果我选择了艺术而非科学',
  '如果我当年鼓起勇气表白', '如果我有一个双胞胎兄弟姐妹', '如果我生活在海边而非内陆',
  '如果我学会了弹吉他', '如果我当初没有放弃画画', '如果我成为一名旅行作家',
  '如果我没有删除那个社交账号', '如果我选择了 Gap Year', '如果我成为了一名运动员',
  '如果我当初买了比特币', '如果我学会了三种语言', '如果我开了一家咖啡馆',
  '如果我没有那场大病', '如果我遇到了不同的导师', '如果我选择了素食生活',
  '如果我住在一个树屋里', '如果我成为一名宇航员', '如果我当初没有转学',
  '如果我写了一本书', '如果我学会了冲浪', '如果我有一个完全不同的名字',
  '如果我生活在另一个时代', '如果我成为了一名兽医', '如果我选择了不同的发型保持至今'
];

app.get('/api/random-topic', (req, res) => {
  const count = Math.max(1, Math.min(parseInt(req.query.count, 10) || 1, 10));
  // Fisher-Yates 洗牌算法（无偏差）
  const shuffled = [...RANDOM_TOPICS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  res.json({ topics: shuffled.slice(0, count) });
});

// ===== 每日运势 =====
const FORTUNES = [
  { level: '大吉', desc: '今日宇宙能量充沛，适合大胆探索未知领域', emoji: '&#127775;' },
  { level: '吉', desc: '平稳中有惊喜，保持开放心态迎接可能', emoji: '&#11088;' },
  { level: '中吉', desc: '适合回顾过去，从中发现新的启发', emoji: '&#127775;' },
  { level: '小吉', desc: '微小的改变可能带来意想不到的收获', emoji: '&#10024;' },
  { level: '吉', desc: '与人交流可能打开新的视角', emoji: '&#129309;' },
  { level: '大吉', desc: '灵感涌现，是创造和表达的好时机', emoji: '&#127912;' },
  { level: '中吉', desc: '放慢脚步，在细节中发现美好', emoji: '&#127800;' }
];

app.get('/api/fortune', (req, res) => {
  const u = getUsername(req);
  const today = new Date();
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  // 基于用户名和日期生成确定性运势
  let seed = dayOfYear;
  if (u) for (const ch of u) seed += ch.charCodeAt(0);
  const fortune = FORTUNES[seed % FORTUNES.length];
  const luckyNum = (seed * 7) % 9 + 1;
  res.json({ ...fortune, luckyNum, date: today.toISOString().slice(0, 10) });
});

// ===== 宇宙年鉴（个人年度报告）=====
app.get('/api/yearbook', (req, res) => {
  try {
    const username = getUsername(req);
    if (!username) return res.status(400).json({ error: '请先登录' });
    const history = readJSON(userFile(username, 'history.json'), []) || [];
    const favorites = readJSON(userFile(username, 'favorites.json'), []) || [];
    const moods = readJSON(userFile(username, 'moods.json'), []) || [];
    const achievements = readJSON(userFile(username, 'achievements.json'), []) || [];
    const stats = readJSON(userFile(username, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 }) || {};

    // 分析统计
    const now = Date.now();
    const yearAgo = now - 365 * 86400000;
    const monthAgo = now - 30 * 86400000;
    const weekAgo = now - 7 * 86400000;

    // 安全过滤：确保每条记录有timestamp字段（兼容time字段）
    const validHistory = history.filter(h => h && (h.timestamp || h.time));
    const yearlyHistory = validHistory.filter(h => (h.timestamp || h.time) > yearAgo);
    const monthlyHistory = validHistory.filter(h => (h.timestamp || h.time) > monthAgo);
    const weeklyHistory = validHistory.filter(h => (h.timestamp || h.time) > weekAgo);

    // 最活跃时段
    const hourCounts = {};
    yearlyHistory.forEach(h => {
      const ts = h.timestamp || h.time;
      if (!ts) return;
      const hour = new Date(ts).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    let peakHour = 0, peakCount = 0;
    Object.entries(hourCounts).forEach(([h, c]) => { if (c > peakCount) { peakHour = parseInt(h, 10); peakCount = c; } });

    // 平均心情
    const validMoods = moods.filter(m => m && typeof m.mood === 'number');
    const avgMood = validMoods.length > 0 ? Math.round(validMoods.reduce((s, m) => s + m.mood, 0) / validMoods.length * 10) / 10 : 0;

    // 最常探索的主题词
    const wordCounts = {};
    validHistory.forEach(h => {
      if (!h.query || typeof h.query !== 'string') return;
      h.query.slice(0, 30).replace(/[，。！？、；：""''（）\s]/g, '').split('').forEach(c => {
        wordCounts[c] = (wordCounts[c] || 0) + 1;
      });
    });
    const topWords = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);

    const users = readJSON(path.join(DATA_DIR, 'users.json'), {}) || {};
    res.json({
      username,
      totalExplores: validHistory.length,
      yearlyExplores: yearlyHistory.length,
      monthlyExplores: monthlyHistory.length,
      weeklyExplores: weeklyHistory.length,
      favoritesCount: favorites.length,
      achievementsCount: achievements.length,
      wheelSpins: stats.wheelSpins || 0,
      peakHour,
      avgMood,
      topWords,
      latestUniverse: (validHistory[0] && validHistory[0].query) ? validHistory[0].query : '尚未探索',
      joinDate: (users[username] || {}).created || Date.now()
    });
  } catch (err) {
    console.error('[Yearbook Error]:', err);
    if (!res.headersSent) res.status(500).json({ error: '年鉴数据加载失败' });
  }
});

// ===== 管理员 API =====
// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'auth')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const { username, password } = req.body || {};
  if (!safeCompare(username, ADMIN_USERNAME) || !safeCompare(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = generateAdminToken();
  adminSessions.set(token, { username, expires: Date.now() + 2 * 60 * 60 * 1000 }); // 2小时有效期
  console.log('[Admin] Login successful:', username);
  res.json({ ok: true, token, username });
});

// 管理员登出
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminSessions.delete(token);
  res.json({ ok: true });
});

// 验证管理员token
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.admin.username });
});

// 获取所有用户
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const userList = Object.entries(users).map(([username, data]) => {
    const udir = userDir(username);
    if (!udir) return null;
    const stats = readJSON(path.join(udir, 'stats.json'), { total: 0, wheelSpins: 0, shares: 0 });
    const history = readJSON(path.join(udir, 'history.json'), []);
    const achievements = readJSON(path.join(udir, 'achievements.json'), []);
    const favorites = readJSON(path.join(udir, 'favorites.json'), []);
    return {
      username,
      created: data.created,
      avatar: data.avatar || userAvatarColor(username),
      totalExplores: history.length,
      achievements: achievements.length,
      favorites: favorites.length,
      wheelSpins: stats.wheelSpins || 0
    };
  }).filter(u => u !== null).sort((a, b) => b.totalExplores - a.totalExplores);
  res.json({ users: userList, total: userList.length });
});

// 删除用户
app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const targetUser = req.params.username;
  if (targetUser === ADMIN_USERNAME) return res.status(400).json({ error: '不能删除管理员账号' });
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  if (!users[targetUser]) return res.status(404).json({ error: '用户不存在' });
  delete users[targetUser];
  writeJSON(path.join(DATA_DIR, 'users.json'), users);
  // 删除用户目录
  const udir = userDir(targetUser);
  try {
    if (fs.existsSync(udir)) fs.rmSync(udir, { recursive: true, force: true });
  } catch(e) { console.warn('[Admin] Failed to delete user dir:', e.message); }
  // 删除该用户的广场分享
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const filtered = shared.filter(s => s.username !== targetUser);
  writeJSON(path.join(SHARED_DIR, 'shared.json'), filtered);
  // 删除该用户的评论
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  Object.keys(comments).forEach(pid => {
    comments[pid] = comments[pid].filter(c => c.username !== targetUser);
  });
  writeJSON(path.join(SHARED_DIR, 'comments.json'), comments);
  console.log('[Admin] Deleted user:', targetUser, 'by', req.admin.username);
  res.json({ ok: true });
});

// 获取所有广场帖子（管理视角，含content）
app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const posts = shared.map(s => ({
    ...s,
    avatar: (users[s.username] && users[s.username].avatar) || userAvatarColor(s.username),
    commentCount: (comments[s.id] || []).length
  }));
  res.json({ posts, total: posts.length });
});

// 删除广场帖子
app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  const postId = req.params.id;
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const idx = shared.findIndex(s => s.id === postId);
  if (idx < 0) return res.status(404).json({ error: '帖子不存在' });
  const post = shared[idx];
  shared.splice(idx, 1);
  writeJSON(path.join(SHARED_DIR, 'shared.json'), shared);
  // 删除该帖子的评论
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  delete comments[postId];
  writeJSON(path.join(SHARED_DIR, 'comments.json'), comments);
  console.log('[Admin] Deleted post:', postId, 'by', req.admin.username, '(query:', post.query, ')');
  res.json({ ok: true });
});

// 获取所有评论
app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const allComments = [];
  Object.entries(comments).forEach(([postId, list]) => {
    const post = shared.find(s => s.id === postId);
    list.forEach(c => {
      allComments.push({
        ...c,
        postId,
        postQuery: post ? post.query : '[已删除]',
        avatar: (users[c.username] && users[c.username].avatar) || userAvatarColor(c.username)
      });
    });
  });
  allComments.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ comments: allComments, total: allComments.length });
});

// 删除评论
app.delete('/api/admin/comments/:postId/:commentId', requireAdmin, (req, res) => {
  const { postId, commentId } = req.params;
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  if (!comments[postId]) return res.status(404).json({ error: '评论不存在' });
  const idx = comments[postId].findIndex(c => c.id === commentId);
  if (idx < 0) return res.status(404).json({ error: '评论不存在' });
  comments[postId].splice(idx, 1);
  writeJSON(path.join(SHARED_DIR, 'comments.json'), comments);
  // 更新帖子评论数
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const post = shared.find(s => s.id === postId);
  if (post) {
    post.commentCount = comments[postId].length;
    writeJSON(path.join(SHARED_DIR, 'shared.json'), shared);
  }
  console.log('[Admin] Deleted comment:', commentId, 'from post:', postId, 'by', req.admin.username);
  res.json({ ok: true });
});

// 获取全站统计
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = readJSON(path.join(DATA_DIR, 'users.json'), {});
  const shared = readJSON(path.join(SHARED_DIR, 'shared.json'), []);
  const comments = readJSON(path.join(SHARED_DIR, 'comments.json'), {});
  let totalExplores = 0, totalHistories = 0;
  Object.keys(users).forEach(u => {
    const h = readJSON(userFile(u, 'history.json'), []);
    totalExplores += h.length;
  });
  totalHistories = readJSON(path.join(DATA_DIR, 'history.json'), []).length;
  totalExplores += totalHistories;
  let totalComments = 0;
  Object.values(comments).forEach(list => totalComments += list.length);
  res.json({
    userCount: Object.keys(users).length,
    postCount: shared.length,
    commentCount: totalComments,
    totalExplores,
    serverUptime: process.uptime()
  });
});

// ===== 404 处理 =====
app.use('/api', (req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

// ===== 全局错误处理中间件（必须放在所有路由之后）=====
// 捕获所有未处理的异常，防止服务器崩溃
app.use((err, req, res, next) => {
    console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.message);
    if (res.headersSent) {
        return next(err);
    }
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message
    });
});

// 定期清理过期条目防止内存泄漏
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  // 清理速率限制
  for (const [ip, entry] of rateLimit) {
    if (now - entry.start > RATE_LIMIT_WINDOW) rateLimit.delete(ip);
  }
  // 清理点赞追踪（保留24小时内的）
  for (const [key, ts] of likeTracker) {
    if (now - ts > 24 * 60 * 60 * 1000) likeTracker.delete(key);
  }
  // 清理过期管理员session
  for (const [token, session] of adminSessions) {
    if (session.expires < now) adminSessions.delete(token);
  }
  // 清理过期缓存
  for (const [key, entry] of cache) {
    if (now - entry.ts > CACHE_TTL * 2) cache.delete(key);
  }
}, 10 * 60 * 1000).unref?.(); // 每10分钟清理一次

// ===== 优雅关闭处理 =====
// 处理 SIGINT/SIGTERM 信号，确保连接正常关闭后再退出
let server = null;
function gracefulShutdown(signal) {
    console.log(`\n[SHUTDOWN] Received ${signal}, closing server gracefully...`);
    // 停止接受新连接
    if (server) {
        server.close(() => {
            console.log('[SHUTDOWN] HTTP server closed');
            // 清理定时器
            if (cleanupInterval) clearInterval(cleanupInterval);
            process.exit(0);
        });
        // 强制超时关闭
        setTimeout(() => {
            console.error('[SHUTDOWN] Forced shutdown after timeout');
            process.exit(1);
        }, 10000).unref();
    } else {
        process.exit(0);
    }
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const PORT = process.env.PORT || 3000; // 默认3000：80端口在Windows下易冲突且需要管理员权限
const HOST = process.env.HOST || '0.0.0.0';
server = app.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(` 如果宇宙 Yuzhou API ${SERVER_VERSION}`);
  console.log(` Running on http://${HOST}:${PORT}`);
  console.log(`========================================`);
  ensureDir(DATA_DIR);
  ensureDir(SHARED_DIR);
  ensureDir(USERS_DIR);
  
  console.log('');
  console.log('【API 配置状态】');
  if (!API_KEY || API_KEY.trim().length === 0) {
    console.warn('⚠️  API Key 未配置或无效！');
    console.warn('   请检查以下环境变量是否设置了正确的值：');
    console.warn('   - API_KEY (通用/推荐)');
    console.warn('   - VOLC_API_KEY / ARK_API_KEY (火山引擎)');
    console.warn('   - DASHSCOPE_API_KEY / ALIYUN_API_KEY (阿里云)');
    console.warn('   - YUZHOU_API_KEY / OPENAI_API_KEY');
    console.warn('   ');
    console.warn('   当前API调用将返回错误信息，用户会看到明确的错误提示。');
    console.warn('   调试端点: http://localhost:' + PORT + '/api/debug/config');
  } else {
    const keyPreview = API_KEY.substring(0, 10) + '...' + API_KEY.substring(API_KEY.length - 6);
    console.log(`✅ API Key 已配置: ${keyPreview} (长度: ${API_KEY.length})`);
    console.log(`✅ 使用环境变量: ${API_KEY_SOURCE}`);
    console.log(`✅ Provider: ${API_PROVIDER}`);
    console.log(`✅ Model: ${MODEL_NAME}`);
    console.log(`✅ API Endpoint: ${API_CHAT_URL}`);
    console.log('');
    console.log('💡 调试端点: http://localhost:' + PORT + '/api/debug/config');

    // ===== provider 与 模型/端点 不匹配的告警 =====
    const m = String(MODEL_NAME).toLowerCase();
    if (API_PROVIDER === 'volcengine') {
      if (looksLikeAliyunModel(m)) {
        console.warn('');
        console.warn('🚨 配置异常：当前判定为【火山引擎】，但模型名是阿里云风格(' + MODEL_NAME + ')，会导致 404 InvalidEndpointOrModel！');
        console.warn('   请设置 ARK_MODEL 为火山引擎的接入点ID（ep- 开头），例如：');
        console.warn('   export ARK_MODEL="ep-xxxxxxxxxxxxx-xxxxx"');
      } else if (!looksLikeVolcModel(m)) {
        console.warn('');
        console.warn('⚠️  提示：火山引擎模型通常为接入点ID(ep-开头)或 doubao 系列，当前为：' + MODEL_NAME);
      }
      if (!String(API_BASE_URL).toLowerCase().includes('volces.com')) {
        console.warn('⚠️  提示：火山引擎接口域名通常为 ark.cn-beijing.volces.com，当前 baseUrl=' + API_BASE_URL);
      }
      if (API_KEY && !API_KEY.toLowerCase().startsWith('ark-')) {
        console.warn('⚠️  提示：火山引擎 Key 通常以 ark- 开头，当前 Key 来源=' + API_KEY_SOURCE + '，可能仍是旧的阿里云 Key。');
      }
    } else if (API_PROVIDER === 'aliyun') {
      if (looksLikeVolcModel(m)) {
        console.warn('');
        console.warn('🚨 配置异常：当前判定为【阿里云】，但模型名是火山风格(' + MODEL_NAME + ')，请核对 provider 配置！');
      }
    }
  }
  console.log('');
  
  if (ADMIN_PASSWORD === 'admin123') {
    console.warn('⚠️  WARNING: 使用默认管理员密码！生产环境请设置 YUZHOU_ADMIN_PASS 环境变量。');
    console.log('');
  }
});

// 端口冲突等监听错误：给出明确指引，而不是抛 uncaughtException 堆栈
// （listen 返回后同步挂载，错误事件异步触发，不会丢失）
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用！`);
    console.error('   解决方法：');
    console.error(`   1) 结束占用进程：Windows: netstat -ano | findstr :${PORT} 后 taskkill /F /PID <pid>`);
    console.error('   2) 或修改 .env 中的 PORT 换一个端口');
    process.exit(1);
  }
  console.error('[SERVER ERROR]', err);
  process.exit(1);
});