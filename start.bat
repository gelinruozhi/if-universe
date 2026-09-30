@echo off
rem ===== 如果宇宙 Windows 一键启动 =====
rem 双击运行或在 cmd 中执行；关闭窗口即停止服务
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   如果宇宙 Yuzhou - 启动中...
echo   启动后访问 http://localhost:3001
echo ========================================
node --env-file-if-exists=.env server.js
pause
