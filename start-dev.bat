@echo off
REM ============================================================
REM CRM-ai-native 日常启动脚本（一键）v2  2026-09-03
REM
REM 背景：PostgreSQL 16 在 WSL Ubuntu 内（systemd 管理，已 enable
REM 自启）。WSL2 的实例空闲自动终止（instanceIdleTimeout，默认
REM 15s）会使最后会话退出后实例被终止 → PG 跟随停止。
REM 已通过 .wslconfig 设置 instanceIdleTimeout=-1 + vmIdleTimeout=-1
REM 彻底关闭自动终止（需 wsl --shutdown 后生效）。
REM
REM 本脚本：拉起 WSL+PG → 等待就绪 → 启动 CRM 服务。
REM ============================================================

REM 第 1 步：拉起 WSL 并启动 PG（systemd enable 已自启，start 幂等兜底）
wsl.exe -d Ubuntu -u root -e sh -c "systemctl start postgresql@16-main; exec sleep infinity" 2>nul
if errorlevel 1 (
  echo [CRM] WSL 拉起失败，尝试直接启动...
  wsl.exe -d Ubuntu
)

REM 第 2 步：等待 PG 就绪（最多 15 秒）
echo [CRM] 等待 PostgreSQL 就绪...
set /a tries=0
:waitloop
wsl.exe -d Ubuntu -u root -e pg_isready -h 127.0.0.1 -p 5433 2>nul | findstr /c:"accepting" >nul
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 15 goto fail
timeout /t 1 /nobreak >nul
goto waitloop

:ready
echo [CRM] PostgreSQL 就绪 (127.0.0.1:5433)
cd /d D:\system\CRM-ai-native
node --watch src/http/server.js
goto end

:fail
echo [CRM] 错误：PostgreSQL 15 秒内未就绪，请检查 WSL/PG
pause
goto end

:end
endlocal