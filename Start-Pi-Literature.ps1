[CmdletBinding()]
param([ValidateSet('Doctor','Worker')][string]$Mode='Doctor',[string]$ProjectRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
if(-not $ProjectRoot){$ProjectRoot=(Get-Location).Path}
Set-Location -LiteralPath $ProjectRoot
if(-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'config.local.json'))){throw 'Please configure config.local.json first. No credential is stored in this launcher.'}
$taskLogs=Join-Path $ProjectRoot 'runtime'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
if(-not $env:PI_LITERATURE_WORKER_TOKEN){
  $taskCredential=Join-Path $taskLogs 'worker-token.dpapi'
  if(Test-Path -LiteralPath $taskCredential){
    $taskSecure=Get-Content -LiteralPath $taskCredential -Raw | ConvertTo-SecureString
    $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    try{$env:PI_LITERATURE_WORKER_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)}
  }elseif($Mode -eq 'Worker'){throw 'Pair this computer first. A worker environment variable or a current-user DPAPI credential is required.'}
}
if($Mode -eq 'Doctor'){try{& npm.cmd run doctor;$taskExit=$LASTEXITCODE}finally{Remove-Item Env:PI_LITERATURE_WORKER_TOKEN -ErrorAction SilentlyContinue};exit $taskExit}
$taskNode=(Get-Command node.exe).Source
try{
  $taskConfig=Get-Content -LiteralPath (Join-Path $ProjectRoot 'config.local.json') -Raw | ConvertFrom-Json
  $taskData=if([IO.Path]::IsPathRooted($taskConfig.dataDir)){$taskConfig.dataDir}else{Join-Path $ProjectRoot $taskConfig.dataDir}
  $taskLock=Join-Path $taskData 'worker.lock'
  if(Test-Path -LiteralPath $taskLock){$taskOwner=Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json;if(Get-Process -Id $taskOwner.pid -ErrorAction SilentlyContinue){'Worker is already running (PID '+$taskOwner.pid+').';return}}
  $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @('--import','tsx','src/worker/main.ts') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'worker.stdout.log') -RedirectStandardError (Join-Path $taskLogs 'worker.stderr.log') -PassThru
  $taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskLogs 'worker-process-id.txt')
  'Worker process started (PID '+$taskProcess.Id+'). The webpage confirms the connection.'
}finally{Remove-Item Env:PI_LITERATURE_WORKER_TOKEN -ErrorAction SilentlyContinue}
