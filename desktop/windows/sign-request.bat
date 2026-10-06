@echo off
rem The scheduled task sign-task.ps1 starts: signs the file named in sign-request.txt with sign.bat.
set /p FILE=<S:\suplex\tmp\sign-request.txt
call S:\suplex\windows\signing-env.bat
call S:\suplex\windows\sign.bat "%FILE%" > S:\suplex\tmp\sign.log 2>&1
>>S:\suplex\tmp\sign.log echo exit=%errorlevel%
