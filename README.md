# 如果宇宙 · IF UNIVERSE

> 以「如果」开头，写下你好奇的另一种人生。AI 为你书写那条没有走的路——五幕人生弧线、四枚记忆碎片，和一封来自未来的信。

**平行人生探索应用**：输入一个人生假设（如"如果我学会了画画"），AI 实时生成该平行宇宙的完整叙事，并可分享到探索广场、碰撞两个宇宙、对比两条时间线、生成你的宇宙年鉴。

曾以《如果宇宙——用AI探索你的平行人生》为题参加 **TRAE AI 创造力大赛**（2026，生活娱乐赛道），从纯前端单文件 Demo 进化为全栈应用。设计语言：深空底色上的编辑部式排版——宋体大字提问、编号索引、等宽元信息、细线分割。

## 功能特性

- **平行人生生成**：SSE 流式输出，首字约 1 秒，五幕场景因果衔接、首尾呼应
- **宇宙碰撞**：两条时间线交汇融合的叙事生成
- **AI 续写**：在已有故事上继续书写
- **探索广场**：分享、评论、点赞其他人的平行宇宙
- **成长系统**：成就徽章、命运转盘、每日挑战、今日运势、宇宙年鉴
- **用户体系**：注册登录、云端同步、平行对比、个人中心
- **PWA**：可安装到主屏幕，离线回退

## 技术架构

| 层 | 实现 |
|---|---|
| 后端 | Node.js (≥22.9) + Express，单文件 `server.js`（ESM） |
| 前端 | 零构建单页应用 `frontend/index.html`（PWA：`sw.js` + `manifest.json`） |
| AI | 阿里云百炼 DashScope `deepseek-v4.1-flash`（OpenAI 兼容 SSE）；兼容火山引擎 ARK |
| 存储 | `data/` 下 JSON 文件：原子写入（tmp + rename）、按文件读写锁，无需数据库 |

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 DASHSCOPE_API_KEY 等
npm start                 # Windows 可双击 start.bat
```

访问 `http://localhost:<PORT>`（默认 3000，见 `.env`）。

> `.env` 由 Node 22 原生 `--env-file-if-exists=.env` 加载，无需 dotenv。未配置密钥也能启动，AI 生成会提示未配置。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 默认 `3000` / `0.0.0.0` |
| `DASHSCOPE_API_KEY` | 阿里云百炼 Key（千问AI平台） |
| `DASHSCOPE_API_URL` | 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DASHSCOPE_MODEL` | 默认 `deepseek-v4.1-flash` |
| `ARK_API_KEY` / `ARK_API_URL` / `ARK_MODEL` | 火山引擎 ARK 备选（`ark-` 前缀 Key 优先级最高） |
| `YUZHOU_ADMIN` / `YUZHOU_ADMIN_PASS` | 管理员账号，默认 `admin` / `admin123`（公网部署务必修改） |
| `YUZHOU_STRICT_AUTH` | 设为 `1` 关闭旧 `x-username` 头兼容，仅允许 token |

> **注意**：`deepseek-v4.1-flash` 默认开启思考模式，服务端已按 provider 传 `enable_thinking: false`，否则首字延迟可达 45 秒且输出被截断。

## AI 接入配置（管理面板）

无需登录服务器改文件：点击页脚的「AI 接入」链接（或登录后用户菜单 →「AI 接入设置」），管理员密码解锁后即可在线修改 **API Key / Base URL / 模型 / 提供商**，支持一键连通性测试（真实调用、不污染运行配置）。

- 保存后**即时生效**，持久化于 `data/ai-config.json`，优先级高于环境变量；「恢复 .env 默认」一键回退
- 面板中 Key 永远脱敏展示（仅首尾片段）；自定义 Base URL 仅允许公网 http(s) 地址（内置 SSRF 防护）
- 入口有两处：页脚链接（所有人可见，但需管理员解锁）+ 用户菜单「AI 接入设置」（仅管理员可见）

## 服务器部署（Linux + PM2）

```bash
cp .env.example .env && vim .env    # 填入密钥与端口
npm install --omit=dev
bash deploy.sh                      # 重建 PM2 进程并保存
```

Nginx 反向代理（SSE 必须关闭缓冲）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;              # 关键：否则流式输出被缓冲
    proxy_read_timeout 120s;
}
```

## 安全说明

- **密钥只存放在 `.env`**（已 gitignore），代码与脚本中无任何凭据；`.env.example` 仅为占位模板
- **`data/` 目录不入库**：含用户密码哈希（scrypt + 随机盐）与个人内容，部署时自动生成
- 密码哈希 scrypt；JSON 原子写 + 按文件串行化；用户名白名单 + 数据目录边界守卫；存储型 XSS 转义
- AI 请求并发上限 3 + 排队 10；限流按业务分桶（AI 10 次/分、登录注册 15 次/分）

## 目录结构

```
├── server.js                 # 后端（路由、SSE、AI 接入、限流、存储）
├── frontend/
│   ├── index.html            # 前端单页应用（含样式与交互）
│   ├── sw.js                 # Service Worker（HTML 网络优先）
│   └── manifest.json         # PWA 清单
├── data/                     # 运行时 JSON 存储（不入库，自动生成）
├── docs/
│   └── trae-work-context.md  # TRAE Work 时期的创作上下文存档
├── deploy.sh                 # Linux PM2 一键部署
├── start.bat                 # Windows 一键启动
└── .env.example              # 环境变量模板
```

## 运维排查

```bash
curl http://127.0.0.1:3001/api/health          # 健康检查（版本/provider/model）
curl http://127.0.0.1:3001/api/debug/config    # 配置自检（管理员 token 可见详情）
pm2 logs yuzhou --lines 50                     # 线上日志
```
