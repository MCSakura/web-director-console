@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  Web Director Console - One-click Deploy Launcher (Windows)
REM  Double-click to enter interactive menu, or pass args:
REM    deploy.bat all        deploy web + danmaku gateway
REM    deploy.bat web        deploy web frontend only
REM    deploy.bat danmaku    deploy danmaku gateway only
REM    deploy.bat status     show server status
REM    deploy.bat -h         show help
REM ============================================================

REM 1. Check Python
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.8+ and add to PATH.
    pause
    exit /b 1
)

REM 2. Check paramiko dependency
python -c "import paramiko" 2>nul
if errorlevel 1 (
    echo Installing dependency: paramiko ...
    python -m pip install paramiko
    if errorlevel 1 (
        echo [ERROR] Failed to install paramiko. Run manually: pip install paramiko
        pause
        exit /b 1
    )
)

REM 3. Run deploy script (pass through all arguments)
python "%~dp0deploy.py" %*
set RC=%ERRORLEVEL%

echo.
if "%~1"=="" (
    REM Interactive mode (double-click): pause to review result
    pause
) else (
    REM Non-interactive mode (with args / CI): exit directly
    echo Deploy script exited with code %RC%.
)
exit /b %RC%
