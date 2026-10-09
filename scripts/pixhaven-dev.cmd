@echo off
rem Development launcher for the PixHaven CLI (run "npm run build" first).
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.." --cli %*
exit /b %ERRORLEVEL%
