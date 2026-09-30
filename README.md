# 如果宇宙 · Yuzhou

「平行人生探索」应用：输入一个人生假设（如"如果我学会了画画"），AI 生成该平行宇宙的完整故事、关键碎片与一封来自未来的信。支持用户系统、探索广场、评论点赞、排行榜、宇宙碰撞、命运转盘、每日挑战、宇宙年鉴等。

## 项目背景

《如果宇宙》是 **TRAE AI 创造力大赛**（2026.6.16 – 8.22，生活娱乐赛道）的参赛作品，曾以《如果宇宙——用AI探索你的平行人生》为题提交至 [TRAE 官方中文社区](https://forum.trae.cn/t/topic/35492)（该帖现仅作者可见）。全程使用 **TRAE Work / TRAE IDE** 创作。

- **竞赛官网**：https://www.trae.cn/ai-creativity
- **赛事细则**：https://bytedance.larkoffice.com/wiki/DScwwZPzsikvNzk5slJc2kgpnie
- **报名指南**：https://forum.trae.cn/t/topic/22548

**演进脉络**：

1. **纯前端 Demo（2026.6.18–19，TRAE Work）**：零依赖单文件 HTML，经 6 轮迭代（`index.html` → `index-final` → `index-competition` → `index-expanded`），内置 8 个预设人生主题与关键词匹配、命运转盘、成就系统等，数据存 localStorage。历史版本与设计决策记录见 [docs/trae-work-context.md](docs/trae-work-context.md)。
2. **全栈版本（2026.7，本仓库）**：接入 Express 后端 + 火山引擎 ARK 流式生成，AI 内容从预设模板升级为实时生成；新增用户账号体系、探索广场（分享/评论/点赞）、排行榜、云同步等，localStorage 键与后端 JSON 存储双向同步。

**设计语言**（自初版延续至今）：深色宇宙主题（基底色 `#030014`）、玻璃拟态、Canvas 星空粒子/星云/流星、紫→蓝渐变品牌标题（品牌名 + ✦ 分隔线 + 副文案"如果你做了另一个选择"）、Polaroid 碎片卡片、信笺红印章，页脚保留 "Made with TRAE"。

## 运行方式

- 后端：Node.js (≥22.9) + Express，单文件 `server.js`（ESM）
- 前端：零构建单页应用 `frontend/index.html`（PWA：`sw.js` + `manifest.json`）
- AI：火山引擎 ARK（OpenAI 兼容 `/chat/completions`，SSE 流式）；也兼容阿里云 DashScope
- 存储：`data/` 下的 JSON 文件（原子写入 + 按文件串行化，无需数据库）

## 本地运行（Windows / macOS / Linux）

```bash
npm install
cp .env.example .env      # 填入 ARK_API_KEY / ARK_MODEL；PORT 默认 3000，可按需修改
npm start                 # 访问 http://localhost:<PORT>（Windows 也可双击 start.bat）
```

> 本机若 3000 端口被其他应用占用（如同目录的 CityCanvas 项目），把 `.env` 里的 `PORT` 改成 3001 等空闲端口即可；服务端内置兜底默认值也是 3000。端口被占用时启动会给出明确提示。

`.env` 由 Node 原生 `--env-file-if-exists=.env` 加载（无需 dotenv，见 `package.json` scripts）。未创建 `.env` 也能启动，但 AI 生成会提示未配置。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 默认 `3000` / `0.0.0.0` |
| `ARK_API_KEY` | 火山引擎 Key（`ark-` 开头，最高优先级） |
| `ARK_API_URL` | 默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `ARK_MODEL` | 火山接入点 ID（`ep-` 开头）或 doubao 系列 |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_MODEL` | 阿里云百炼（`sk-` 开头）备选 |
| `YUZHOU_ADMIN` / `YUZHOU_ADMIN_PASS` | 管理员账号，默认 `admin` / `admin123`（生产务必修改） |
| `YUZHOU_STRICT_AUTH` | 设为 `1` 关闭旧的 `x-username` 头兼容，仅允许 token |

Key 自动识别规则：`ark-` 前缀 → 火山引擎；`sk-` → 阿里云/OpenAI 兼容。

## 服务器部署（Linux + PM2）

```bash
# 服务器上（目录 /var/www/yuzhou）
cp .env.example .env && vim .env    # 填入密钥与端口
npm install --omit=dev
bash deploy.sh                      # 重建 PM2 进程并保存
```

Nginx 反向代理建议（SSE 必须关闭缓冲）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;          # 关键：否则流式输出被缓冲
    proxy_read_timeout 120s;
}
```

## 常用运维命令

```bash
curl http://127.0.0.1:3000/api/health          # 健康检查（版本/provider/model）
curl http://127.0.0.1:3000/api/debug/config    # 配置自检（管理员token可见详情）
pm2 logs yuzhou --lines 50                     # 日志
```

## 架构要点

- **SSE 流式生成**：`server.js` 的 `createSSEStream` 统一处理心跳（15s）、首 token 超时提示（30s）、总超时（90s）、客户端断连清理、批量输出（首屏 2 字符即吐）
- **并发保护**：AI 请求最多并发 3、排队 10；限流按业务分桶（AI 10次/分、登录注册 15次/分）
- **数据安全**：JSON 原子写（tmp + rename）、按文件读写锁、密码 scrypt + 随机盐（旧哈希登录自动升级）、存储型 XSS 转义、用户名白名单
- **登录自愈**：登录时自动补建缺失的用户数据文件（不覆盖已有数据）
- **传输优化**：gzip 压缩（SSE 除外），首页 516KB → 133KB；`sw.js` 禁缓存保证 PWA 更新即时生效

## 数据备份

全部状态在 `data/` 目录，直接整目录备份即可。删除某用户请走管理后台（会连带清理其帖子和评论）。
