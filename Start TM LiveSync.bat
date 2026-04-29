@echo off
title TM LiveSync Setup ^& Run
color 0B

echo ==================================================
echo.
echo    TM LiveSync - Trackmania Skin Previewer
echo.
echo ==================================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python is not installed or not in your PATH.
    echo Please install Python from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b
)

echo [1/2] Checking dependencies...
python -m pip install -r requirements.txt --disable-pip-version-check
IF %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install dependencies. Please check your internet connection.
    pause
    exit /b
)

echo.
echo [2/2] Starting local server...
echo The viewer will open automatically in your browser.
echo Keep this window open while you are working on your skin.
echo.
python server.py

pause
