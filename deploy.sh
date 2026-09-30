#!/bin/bash
# ===== 如果宇宙 一键部署脚本 v4.5.0 =====
# 用法：在服务器上执行 bash deploy.sh
# 前置：在项目根目录创建 .env（参考 .env.example），至少包含：
#   ARK_API_KEY / ARK_API_URL / ARK_MODEL / PORT
# 安全：密钥只存放在 .env（已加入 .gitignore），不再写进脚本

cd /var/www/yuzhou || exit 1

if [ ! -f .env ]; then
  echo "❌ 未找到 .env 文件！请先执行："
  echo "   cp .env.example .env && vim .env   # 填入 ARK_API_KEY 等"
  exit 1
fi

echo "========================================"
echo "  如果宇宙 部署脚本 v4.5.0"
echo "========================================"

# 1. 彻底删除PM2进程（清除所有缓存的旧环境变量）
echo "[1/5] 删除旧PM2进程..."
pm2 delete yuzhou 2>/dev/null
echo "  ✅ 已删除"

# 2. 清除PM2 dump中的旧配置
echo "[2/5] 清除PM2保存的旧配置..."
pm2 save --force 2>/dev/null
echo "  ✅ 已清除"

# 3. 初始化数据文件
echo "[3/5] 初始化数据文件..."
[ ! -f data/favorites.json ] && echo '[]' > data/favorites.json
echo "  ✅ 已完成"

# 4. 启动（.env 由 Node 原生 --env-file 加载，缺省不报错由上方校验兜底）
echo "[4/5] 启动服务（配置来自 .env）..."
pm2 start server.js --name yuzhou --node-args="--env-file-if-exists=.env"
echo "  ✅ 已启动"

# 5. 保存PM2配置
echo "[5/5] 保存PM2配置..."
pm2 save
echo "  ✅ 已保存"

# 验证
echo ""
echo "========================================"
echo "  部署完成！验证结果："
echo "========================================"
sleep 2
pm2 logs yuzhou --lines 15 --nostream 2>&1 | grep -E "Running|Provider|Model|Endpoint|使用环境|API Key"

echo ""
echo "如果上方显示 Provider: volcengine 和 Model: ep-...，则部署成功！"
echo "如果有问题，执行：curl http://127.0.0.1:3000/api/debug/config"
