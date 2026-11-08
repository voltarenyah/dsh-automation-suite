@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File C:\Users\Public\Desktop\remove-webview2.ps1'"
pause
