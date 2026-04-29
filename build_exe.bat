@echo off
title Build TM LiveSync EXE
echo Building TM LiveSync Executable...

REM Install pyinstaller just in case
python -m pip install pyinstaller

REM Clean previous builds
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist TMLiveSync.spec del TMLiveSync.spec

REM Compile into a single executable and bundle static/assets folders
python -m PyInstaller --name "TMLiveSync" --onefile --add-data "static;static" --add-data "assets;assets" server.py

echo.
echo Build complete! Your standalone executable is inside the 'dist' folder.
pause
