[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [string]$DataRoot = 'C:\ProgramData\PiLiteratureCloud',
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$SecretEnvFile,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$taskProjectPath = [System.IO.Path]::GetFullPath($ProjectPath)
$taskDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$taskNodePath = [System.IO.Path]::GetFullPath($NodePath)
if ($taskDataRoot -eq [System.IO.Path]::GetPathRoot($taskDataRoot)) { throw 'DataRoot must be a dedicated subdirectory.' }
foreach ($taskFile in @('src\cloud\main.ts','src\cloud\server.ts','node_modules\tsx\package.json','deploy\windows\start-cloud.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskProjectPath $taskFile))) { throw "Missing deployment prerequisite: $taskFile" }
}
if (-not (Test-Path -LiteralPath $taskNodePath)) { throw 'Node.js executable was not found.' }
$taskNodeVersionText = & $taskNodePath --version
if ($LASTEXITCODE -ne 0 -or [Version]($taskNodeVersionText.TrimStart('v')) -lt [Version]'22.19.0') { throw 'Node.js 22.19 or newer is required.' }
if (Get-NetTCPConnection -LocalPort 4326 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 4326 is already in use; no existing service will be changed.' }
if (Get-ScheduledTask -TaskName 'PiLiteratureCloud' -ErrorAction SilentlyContinue) { throw 'The task already exists; review it before a deliberate update.' }
if (-not $Install) {
    Write-Output 'Preflight complete. Deployment is disabled. OAuth settings and -Install are required to register the new task.'
    exit 0
}
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal($taskIdentity)
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installation requires an elevated PowerShell session.' }
if (-not $SecretEnvFile -or -not (Test-Path -LiteralPath $SecretEnvFile)) { throw 'Provide a private OAuth environment file; installation stays disabled.' }
$taskSettingsMap = @{}
foreach ($taskLine in [System.IO.File]::ReadAllLines([System.IO.Path]::GetFullPath($SecretEnvFile))) {
    if ($taskLine -match '^\s*(#|$)') { continue }
    if ($taskLine -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw 'Invalid service environment file.' }
    $taskSettingsMap[$Matches[1]] = $Matches[2]
}
foreach ($taskKey in @('CLOUD_PUBLIC_URL','CLOUD_WEB_URL','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_ALLOWED_LOGINS')) {
    if (-not $taskSettingsMap[$taskKey]) { throw "Missing $taskKey; installation stays disabled." }
}
if (-not $taskSettingsMap['CLOUD_PUBLIC_URL'].StartsWith('https://')) { throw 'The external API URL must use HTTPS.' }
if (Test-Path -LiteralPath $taskDataRoot) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskDataRoot '.pi-literature-deployment'))) { throw 'Existing DataRoot has no project marker; it will not be modified.' }
}
New-Item -ItemType Directory -Path $taskDataRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $taskDataRoot 'data') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $taskDataRoot '.pi-literature-deployment'),'Pi Literature Cloud 1')
Copy-Item -LiteralPath $SecretEnvFile -Destination (Join-Path $taskDataRoot 'service.env') -Force
# Grant only this deployment tree. The existing server applications and proxy are untouched.
& icacls.exe $taskDataRoot '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict service directory permissions.' }
& icacls.exe (Join-Path $taskDataRoot 'data') '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to grant private data-directory access.' }
& icacls.exe $taskProjectPath '/grant' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to grant application read access.' }
$taskScript = Join-Path $taskProjectPath 'deploy\windows\start-cloud.ps1'
foreach ($taskQuotedValue in @($taskScript,$taskProjectPath,$taskDataRoot,$taskNodePath)) { if ($taskQuotedValue.Contains('"')) { throw 'Paths cannot contain quotation marks.' } }
$taskArguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "{0}" -ProjectPath "{1}" -DataRoot "{2}" -NodePath "{3}"' -f $taskScript,$taskProjectPath,$taskDataRoot,$taskNodePath
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $taskArguments -WorkingDirectory $taskProjectPath
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
$taskServicePrincipal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PiLiteratureCloud' -Action $taskAction -Trigger $taskTrigger -Principal $taskServicePrincipal -Settings $taskSettings -Description 'Independent Pi literature API on loopback port 4326.' | Out-Null
Write-Output 'Task registered under LOCAL SERVICE. It is not started. Review proxy and OAuth configuration before Start-ScheduledTask.'
