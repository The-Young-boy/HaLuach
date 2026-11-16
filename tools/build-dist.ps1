# Builds dist\out\HaLuach-Setup.cmd: the single-file installer for other machines (copied from HaFeed's).
# Own package identity and CLSIDs, so it can sit next to the dev package (HaLuachWidget).
# -Next: raise the version first (a release). Without it the build keeps the current version (a rebuild).
# Hosts: the dev copy loads its own private address, the release https://the-young-boy.github.io/HaLuach/board/ (an identifier only, never served)
# (the same split as HaFeed's dev.hagizra.news / hagizra.news). Nothing is served from either: the provider answers.
param([switch]$Next)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if ($Next) {
    $mf = Get-Content package\AppxManifest.xml -Raw
    $v = [regex]::Match($mf, 'Identity[^>]*Version="(\d+)\.(\d+)\.(\d+)\.0"')
    $mf -replace '(Identity[^>]*Version=")[\d.]+(")', "`${1}$($v.Groups[1]).$($v.Groups[2]).$([int]$v.Groups[3].Value + 1).0`$2" | Set-Content package\AppxManifest.xml -NoNewline
}
$Clsid  = '9275A1DA-98D2-4234-80F2-6A43B5379613'   # the feed class (main.rs HL_CLSID)
$WClsid = '55F8D7E1-0941-4057-A398-B53694DB9A5A'   # the widgets class (main.rs HL_WCLSID)
$DevClsid = 'F85756F5-BFE8-4602-8E67-01532B35D253'; $DevWClsid = '5D6EE3CC-E6D3-462A-AD07-F05CF4816599'
$out = "$root\dist\out"; $stage = "$out\stage"
New-Item -ItemType Directory -Force $out | Out-Null

# 1. Self-check of the policy patch, against a stock copy of the Windows file (region-policy\original.json).
$ast = [Management.Automation.Language.Parser]::ParseFile("$root\dist\Setup.template.cmd", [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Get-PatchedPolicy' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($v in $ast.FindAll({ $args[0] -is [Management.Automation.Language.AssignmentStatementAst] -and "$($args[0].Left)" -eq '$Rules' }, $true)) { . ([scriptblock]::Create($v.Extent.Text)) }
if ($Rules.Count -lt 1) { throw '$Rules not found in the template' }
$orig = [IO.File]::ReadAllText("$root\region-policy\original.json")
$patched = Get-PatchedPolicy $orig 'IL'
if ($patched.Replace('"IL", ', '') -ne $orig) { throw 'policy patch changed more than the inserted region codes' }
if ((Get-PatchedPolicy $patched 'IL') -ne $patched) { throw 'policy patch is not idempotent' }
if (([regex]::Matches($patched, '"IL"')).Count -ne $Rules.Count) { throw 'policy patch missed a rule' }

# 2. The page (embedded in the exe), then the exe without local paths in its panic strings.
node web/build.mjs
if ($LASTEXITCODE) { throw 'page build failed' }
$env:HL_CLSID = $Clsid
$env:HL_WCLSID = $WClsid
# The provider compares this with the GitHub releases (update.rs); the dev build has none and never updates.
$env:HL_VERSION = [regex]::Match((Get-Content package\AppxManifest.xml -Raw), 'Identity[^>]*Version="([\d.]+)"').Groups[1].Value -replace '\.0$', ''
$env:CARGO_TARGET_DIR = "$root\target\dist"
$env:RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE\.cargo\registry\src=crates --remap-path-prefix=$root=src"
cargo build --release -q
$failed = $LASTEXITCODE
Remove-Item Env:HL_CLSID, Env:HL_WCLSID, Env:HL_VERSION, Env:CARGO_TARGET_DIR, Env:RUSTFLAGS
if ($failed) { throw 'build failed' }
$exe = "$root\target\dist\release\haluach-widget.exe"
$bin = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($exe))
if ($bin -match [regex]::Escape($env:USERNAME)) { throw 'exe still contains a local path' }
if ($bin -notmatch $Clsid -or $bin -notmatch $WClsid -or $bin -match $DevClsid -or $bin -match $DevWClsid) { throw 'exe classes not replaced (HL_CLSID / HL_WCLSID)' }

# 3. Package: dev manifest with the distribution identity. Images-dev (the red logo) stays out.
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\Images", "$stage\Sounds", "$stage\Public" | Out-Null
Copy-Item $exe -Destination $stage
Copy-Item package\Images\* -Destination "$stage\Images" -Recurse
Copy-Item package\Sounds\* -Destination "$stage\Sounds"   # radio::alert_sound plays them from ms-appx:///Sounds/
Set-Content "$stage\Public\readme.txt" 'HaLuach' -Encoding ascii   # makeappx drops empty folders
$m = Get-Content package\AppxManifest.xml -Raw
$version = [regex]::Match($m, 'Identity[^>]*Version="([\d.]+)"').Groups[1].Value
$m = $m -replace 'Name="HaLuachWidget"', 'Name="HaLuach"' `
        -replace 'Publisher="CN=HaLuach Dev"', 'Publisher="CN=HaLuach"' `
        -replace '<PublisherDisplayName>[^<]*', '<PublisherDisplayName>יאנג בוי' `
        -replace $DevClsid, $Clsid `
        -replace $DevWClsid, $WClsid `
        -replace 'https://the-young-boy\.github\.io/HaLuach-dev/board/', 'https://the-young-boy.github.io/HaLuach/board/'   # the dev copy has its own address, so the two never share requests or settings
if ($m -match 'HaLuach Dev') { throw 'manifest still names the dev publisher' }
if ($m -match 'HaLuach-dev') { throw 'manifest still names the dev host' }
if ($m -notmatch $Clsid -or $m -notmatch $WClsid -or $m -match $DevClsid -or $m -match $DevWClsid) { throw 'manifest classes not replaced' }
if ($m -notmatch 'Identity Name="HaLuach" Publisher="CN=HaLuach"') { throw 'manifest identity not replaced' }
[IO.File]::WriteAllText("$stage\AppxManifest.xml", $m, [Text.UTF8Encoding]::new($false))
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName | Select-Object -Last 1
& $makeappx.FullName pack /o /d $stage /p "$out\HaLuach.msix" | Out-Null
if ($LASTEXITCODE) { throw 'makeappx failed' }

# 4. Sign. Windows refuses unsigned packages that run an exe, so the installer trusts this certificate
#    (LocalMachine\TrustedPeople only). The private key stays in this user's store; a new one is made if it is lost.
#    A new certificate means installed copies cannot update to the new package: keep this one.
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=HaLuach' -and $_.NotAfter -gt (Get-Date).AddYears(1) } | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=HaLuach' -KeyUsage DigitalSignature -FriendlyName 'HaLuach package signing' `
        -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(10) -KeyExportPolicy NonExportable `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    $cert = Get-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"   # pwsh 7 returns a deserialized object from the PKI module
}
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName | Select-Object -Last 1
& $signtool.FullName sign /q /fd SHA256 /sha1 $cert.Thumbprint /s My "$out\HaLuach.msix"
if ($LASTEXITCODE) { throw 'signtool failed' }

# 5. One CMD: the template, then the package, the certificate and the logo as base64 inside a PowerShell comment.
$v = $version -replace '\.0$', ''
$cmd = [IO.File]::ReadAllText("$root\dist\Setup.template.cmd").Replace('{{VERSION}}', $v).Replace('{{CERT}}', $cert.Thumbprint) -replace "`r?`n", "`r`n"
$cmd += "<#`r`nCERT:" + [Convert]::ToBase64String($cert.RawData) +
        "`r`nMSIX:" + [Convert]::ToBase64String([IO.File]::ReadAllBytes("$out\HaLuach.msix")) +
        "`r`nLOGO:" + [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\package\Images\logo.png")) + "`r`n#>`r`n"
[IO.File]::WriteAllText("$out\HaLuach-Setup.cmd", $cmd, [Text.UTF8Encoding]::new($false))
Remove-Item $stage -Recurse -Force
# HaLuach.msix and HaLuach-Setup.cmd are the release assets the updater and the installer look for (update.rs, Setup.template.cmd).
"built $out\HaLuach-Setup.cmd and $out\HaLuach.msix ($v, $([int]((Get-Item "$out\HaLuach-Setup.cmd").Length / 1KB)) KB)"
