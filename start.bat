@echo off
chcp 65001 >nul
title Yuzhou - If Universe
cd /d "%~dp0"
echo ========================================
echo   Yuzhou (If Universe) - starting...
echo   Open: http://localhost:3001
echo   Close this window to stop the server.
echo ========================================
node --env-file-if-exists=.env server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
