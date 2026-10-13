[CmdletBinding()]
param([ValidateSet('Doctor','Worker')][string]$Mode='Doctor')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.local.json'))){throw 'Please configure config.local.json first. No credential is stored in this launcher.'}
if($Mode -eq 'Doctor'){& npm.cmd run doctor;exit $LASTEXITCODE}
if(-not $env:PI_LITERATURE_WORKER_TOKEN){throw 'Pair the worker in the authenticated webpage and set PI_LITERATURE_WORKER_TOKEN first.'}
$taskLogs=Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
$taskNode=(Get-Command node.exe).Source
Start-Process -FilePath $taskNode -ArgumentList @('--import','tsx','src/worker/main.ts') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'worker.stdout.log') -RedirectStandardError (Join-Path $taskLogs 'worker.stderr.log')
'Worker started. Actual connection and progress are shown in the webpage.'
