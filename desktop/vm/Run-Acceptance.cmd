@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File C:\Users\Public\Desktop\run-clean-acceptance.ps1'"
pause
