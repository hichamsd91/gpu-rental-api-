@echo off
chcp 65001 >nul
echo Starting GPU Rental Server...
echo.

powershell -ExecutionPolicy Bypass -File "F:\src\flutter_application_1\server\start-server.ps1"

pause
