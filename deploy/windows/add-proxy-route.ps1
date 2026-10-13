[CmdletBinding()]
param([string]$ConfigPath='C:\ProgramData\HadesServer\ops\Caddyfile',[string]$CaddyPath='C:\ProgramData\HadesServer\caddy\caddy.exe',[string]$BackupRoot='C:\ProgramData\PiLiteratureCloud\backups',[switch]$Apply)
$ErrorActionPreference='Stop'
$taskConfigPath=[IO.Path]::GetFullPath($ConfigPath)
$taskBackupRoot=[IO.Path]::GetFullPath($BackupRoot)
if(-not (Test-Path -LiteralPath $taskConfigPath)){throw 'Existing proxy configuration not found.'}
$taskOld=[IO.File]::ReadAllText($taskConfigPath)
if($taskOld.Contains('/literature/')){throw 'Literature route already exists; inspect current state before updating.'}
$taskSite='https://122.51.44.155 {'
if([regex]::Matches($taskOld,[regex]::Escape($taskSite)).Count -ne 1){throw 'Expected site block is ambiguous; no proxy mutation performed.'}
$taskRoute=@'

    handle_path /literature/* {
        reverse_proxy 127.0.0.1:4326
    }
'@
$taskNew=$taskOld.Replace($taskSite,$taskSite+$taskRoute)
New-Item -ItemType Directory -Path $taskBackupRoot -Force | Out-Null
$taskCandidate=Join-Path $taskBackupRoot 'Caddyfile.literature.candidate'
[IO.File]::WriteAllText($taskCandidate,$taskNew,[Text.UTF8Encoding]::new($false))
& $CaddyPath validate --config $taskCandidate
if($LASTEXITCODE -ne 0){throw 'Candidate validation failed; existing proxy is unchanged.'}
if(-not $Apply){'Candidate validated. Add -Apply only for the reviewed route.';exit 0}
$taskBackup=Join-Path $taskBackupRoot ('Caddyfile.'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.backup')
Copy-Item -LiteralPath $taskConfigPath -Destination $taskBackup
[IO.File]::WriteAllText($taskConfigPath,$taskNew,[Text.UTF8Encoding]::new($false))
& $CaddyPath reload --config $taskConfigPath
if($LASTEXITCODE -ne 0){Copy-Item -LiteralPath $taskBackup -Destination $taskConfigPath -Force;throw 'Reload failed; original proxy file restored.'}
'New literature route is active. Existing route text retained and original file backed up.'
