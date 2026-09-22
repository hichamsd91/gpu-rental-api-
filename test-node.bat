@echo off
chcp 65001 >nul
echo Test 1: Running a simple JS file
echo.

set TEST_FILE=F:\src\flutter_application_1\server\src\server-test.js
echo Test file: %TEST_FILE%
echo.

if not exist "%TEST_FILE%" (
    echo ERROR: test file not found
    pause
    exit /b 1
)

echo Running: node "%TEST_FILE%"
"C:\Program Files\nodejs\node.exe" "%TEST_FILE%"

echo.
echo Test 2: Running server.js directly
echo.

set SERVER_FILE=F:\src\flutter_application_1\server\src\server.js
echo Server file: %SERVER_FILE%
echo.

if not exist "%SERVER_FILE%" (
    echo ERROR: server.js not found
    pause
    exit /b 1
)

echo Running: node "%SERVER_FILE%"
"C:\Program Files\nodejs\node.exe" "%SERVER_FILE%"

pause
