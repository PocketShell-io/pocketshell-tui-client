@echo off
"%~dp0node.exe" "%~dp0psc\dist\cli.js" %*
exit /b %errorlevel%
