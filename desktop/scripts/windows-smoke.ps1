# GitHub's Windows runner is elevated; PostgreSQL must run as a standard user.
# The account and password exist only on the disposable runner, never in the product.
$ErrorActionPreference = 'Stop'
$userName = 'backlotci'
$password = [guid]::NewGuid().ToString('N') + '!aA9'
Write-Output "::add-mask::$password"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$credential = [pscredential]::new("$env:COMPUTERNAME\$userName", $secure)
$desktop = Split-Path $PSScriptRoot -Parent
$workspace = Split-Path $desktop -Parent
$node = (Get-Command node.exe).Source
$tempDir = Join-Path $workspace '.backlot-ci-temp'
$childScript = Join-Path $tempDir 'run.ps1'
$stdout = Join-Path $tempDir 'stdout.log'
$stderr = Join-Path $tempDir 'stderr.log'
New-Item -ItemType Directory -Force $tempDir | Out-Null
try {
  New-LocalUser -Name $userName -Password $secure -AccountNeverExpires -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $userName
  & icacls.exe $workspace /grant "${userName}:(OI)(CI)M" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant the test user access to the checkout.' }
  $scriptBody = @'
$ErrorActionPreference = 'Stop'
$desktop = '__DESKTOP__'
$node = '__NODE__'
$env:TEMP = '__TEMP__'
$env:TMP = $env:TEMP
$env:LOCALAPPDATA = Join-Path $env:TEMP 'local-appdata'
$env:APPDATA = Join-Path $env:TEMP 'appdata'
$env:ELECTRON_CACHE = Join-Path $env:LOCALAPPDATA 'electron'
New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA, $env:ELECTRON_CACHE | Out-Null
Set-Location $desktop
& $node (Join-Path $desktop 'scripts/test-database.cjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $node (Join-Path $desktop 'scripts/smoke.cjs')
exit $LASTEXITCODE
'@
  $scriptBody.Replace('__DESKTOP__', $desktop).Replace('__NODE__', $node).Replace('__TEMP__', $tempDir) | Set-Content $childScript
  $process = Start-Process -FilePath (Get-Command pwsh.exe).Source -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $childScript) `
    -Credential $credential -LoadUserProfile -WorkingDirectory $desktop -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (Test-Path $stdout) { Get-Content $stdout }
  if (Test-Path $stderr) { Get-Content $stderr }
  if ($process.ExitCode -ne 0) { throw "Windows standard-user checks failed ($($process.ExitCode))." }
} finally {
  Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
}
