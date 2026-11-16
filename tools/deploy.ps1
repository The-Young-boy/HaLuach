# Build, copy to %LOCALAPPDATA%\HaLuach-dev and re-register. The release version is not raised here (a test is not
# a version): tools/build-dist.ps1 -Next raises it for a release.
# The platform relaunches the provider by itself, so the copy retries until the exe is free.
param([string]$Dst = "$env:LOCALAPPDATA\HaLuach-dev")
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
node web/build.mjs
if ($LASTEXITCODE) { throw "page build failed" }
cargo build --release -q
if ($LASTEXITCODE) { throw "build failed" }
$m = Get-Content package\AppxManifest.xml -Raw
$ver = { param($t) [version][regex]::Match($t, 'Identity[^>]*Version="([\d.]+)"').Groups[1].Value }
$next = & $ver $m
# Windows re-registers a changed package only under a higher version: the dev copy counts its deploys in the
# fourth part (0.3.116.1, .2, ...); the first three are the release's and change only with build-dist -Next.
if (Test-Path "$Dst\AppxManifest.xml") {
    $had = & $ver (Get-Content "$Dst\AppxManifest.xml" -Raw)
    if ($had -ge $next) { $next = [version]::new($had.Major, $had.Minor, $had.Build, $had.Revision + 1) }
}
New-Item -ItemType Directory -Force "$Dst\Images", "$Dst\Public" | Out-Null
Copy-Item package\Images\* "$Dst\Images" -Recurse -Force
# The dev copy has a red logo, so it is not mistaken for the installed release beside it.
Copy-Item package\Images-dev\* "$Dst\Images" -Force
# The red-alert sounds (radio::alert_sound plays them from ms-appx:///Sounds/).
New-Item -ItemType Directory -Force "$Dst\Sounds" | Out-Null
Copy-Item package\Sounds\* "$Dst\Sounds" -Force
for ($i = 0; $i -lt 10; $i++) {
    # Only the dev copy: the installed release runs the same exe name and is left alone.
    Get-Process haluach-widget -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dst\*" } | Stop-Process -Force
    try { Copy-Item target\release\haluach-widget.exe $Dst -Force; break } catch { Start-Sleep -Milliseconds 400 }
}
$m -replace '(Identity[^>]*Version=")[\d.]+(")', "`${1}$next`$2" | Set-Content "$Dst\AppxManifest.xml" -NoNewline
Add-AppxPackage -Register "$Dst\AppxManifest.xml" -ForceApplicationShutdown   # only this package: the board may have restarted its provider
"deployed $next"
