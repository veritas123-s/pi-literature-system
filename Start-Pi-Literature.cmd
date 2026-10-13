@echo off
pushd "%~dp0"
powershell.exe -NoProfile -WindowStyle Hidden -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('Start-Pi-Literature.ps1'))) -Mode Worker -ProjectRoot (Get-Location).Path"
popd
