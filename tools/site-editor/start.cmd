@echo off
rem Double-click to start the in-browser copy editor for site/.
setlocal
node "%~dp0server.mjs" %*
if errorlevel 1 pause
