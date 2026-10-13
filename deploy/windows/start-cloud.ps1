[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$taskProjectPath = [System.IO.Path]::GetFullPath($ProjectPath)
$taskDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$taskEnvFile = Join-Path $taskDataRoot 'service.env'
if (-not (Test-Path -LiteralPath $taskEnvFile)) { throw 'Missing private service.env; deployment stays disabled.' }
foreach ($taskLine in [System.IO.File]::ReadAllLines($taskEnvFile)) {
    if ($taskLine -match '^\s*(#|$)') { continue }
    if ($taskLine -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw 'Invalid service.env entry.' }
    $taskKey = $Matches[1]
    $taskValue = $Matches[2]
    if ($taskKey -notin @('CLOUD_PUBLIC_URL','CLOUD_WEB_URL','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_ALLOWED_LOGINS','CLOUD_LEASE_MS','CLOUD_SESSION_MS')) { throw 'Unexpected service environment key.' }
    [System.Environment]::SetEnvironmentVariable($taskKey, $taskValue, 'Process')
}
foreach ($taskRequiredKey in @('CLOUD_PUBLIC_URL','CLOUD_WEB_URL','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_ALLOWED_LOGINS')) {
    if (-not [System.Environment]::GetEnvironmentVariable($taskRequiredKey,'Process')) { throw "Missing $taskRequiredKey; deployment stays disabled." }
}
$env:CLOUD_HOST = '127.0.0.1'
$env:CLOUD_PORT = '4326'
$env:CLOUD_DATA_DIR = Join-Path $taskDataRoot 'data'
$env:CLOUD_DEV_AUTH = 'false'
Set-Location -LiteralPath $taskProjectPath
& $NodePath --import tsx src/cloud/main.ts 1>> (Join-Path $taskDataRoot 'data\cloud.stdout.log') 2>> (Join-Path $taskDataRoot 'data\cloud.stderr.log')
exit $LASTEXITCODE
