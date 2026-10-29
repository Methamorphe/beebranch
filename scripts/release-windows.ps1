#Requires -Version 5.1
<#
.SYNOPSIS
    Build, sign and publish the Windows bundle of an already-published
    BeeBranch release.

.DESCRIPTION
    The release workflow builds every platform from a tag; this script covers
    the case where a release only carries the macOS artifacts and the Windows
    installer has to be produced from a Windows machine.

      1. checks HEAD is the release tag and the tree is clean;
      2. checks the version agrees across tauri.conf.json, package.json,
         Cargo.toml and the tag;
      3. builds the NSIS bundle with the release update endpoint baked in and
         the minisign key from src-tauri/keys;
      4. verifies the updater signature against the pubkey embedded in
         tauri.conf.json, which is the one installed clients trust;
      5. installs the bundle silently, runs BeeBranch.exe --version, then
         uninstalls it;
      6. rebuilds latest.json from the manifest currently published plus the
         new windows-x86_64 fragment, so the darwin/linux entries survive;
      7. uploads the artifacts, then the manifest, to the release repository,
         and checks the published URL and size.

    rollback.json is never touched: it keeps pointing at the previous signed
    version.

    The script is ASCII only on purpose: Windows PowerShell 5.1 decodes UTF-8
    scripts without a BOM as ANSI.

.PARAMETER Version
    Release version, e.g. 0.6.2. Defaults to the version in tauri.conf.json.

.PARAMETER Tag
    Release tag, defaults to v<Version>. HEAD must be that commit and the
    release must already exist in -Repo.

.PARAMETER Repo
    Repository that hosts the releases, defaults to Methamorphe/beebranch.

.PARAMETER Endpoint
    Value compiled in as BEEBRANCH_UPDATE_ENDPOINT. Defaults to the
    latest.json of -Repo, which is also the Rust fallback; set it only to
    publish through another host.

.PARAMETER KeyFile
    Minisign private key, used only when TAURI_SIGNING_PRIVATE_KEY is unset.

.PARAMETER PasswordFile
    Minisign key password, used only when TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    is unset.

.PARAMETER SkipBuild
    Reuse an existing target/release/bundle (hors Windows, pour rejouer le
    manifeste et la publication).

.PARAMETER SkipSmoke
    Skip the silent install check.

.PARAMETER NoUpload
    Stop after the manifest is generated and print the upload commands.

.PARAMETER AllowVersionMismatch
    Publish a windows-only manifest even though the published manifest is for
    another version. macOS/Linux clients then get no update for this version.

.PARAMETER SkipCleanCheck
    Allow a dirty working tree (the build then no longer matches the tag).

.EXAMPLE
    .\scripts\release-windows.ps1 -Version 0.6.2

.EXAMPLE
    .\scripts\release-windows.ps1 -Version 0.6.2 -NoUpload -SkipSmoke
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Tag,
  [string]$Repo = 'Methamorphe/beebranch',
  [string]$Endpoint,
  [string]$KeyFile = 'src-tauri/keys/release.key',
  [string]$PasswordFile = 'src-tauri/keys/release.key.password',
  [switch]$SkipBuild,
  [switch]$SkipSmoke,
  [switch]$NoUpload,
  [switch]$AllowVersionMismatch,
  [switch]$SkipCleanCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0

$script:root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $script:root

$script:step = 0
$script:utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT

function Step([string]$Title) {
  $script:step++
  Write-Host ''
  Write-Host ("[{0}] {1}" -f $script:step, $Title) -ForegroundColor Cyan
}

function Note([string]$Message) {
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Warn([string]$Message) {
  Write-Host "    ATTENTION : $Message" -ForegroundColor Yellow
}

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-LastExit([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What a echoue (code $LASTEXITCODE)" }
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
  & $Command
  Assert-LastExit $What
}

function Assert-Command([string[]]$Names) {
  foreach ($name in $Names) {
    Assert ([bool](Get-Command $name -ErrorAction SilentlyContinue)) "commande introuvable dans PATH : $name"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path $Path), $Content, $script:utf8NoBom)
}

function Get-BundleArtifacts {
  $nsisDir = Join-Path $script:root 'target/release/bundle/nsis'
  Assert (Test-Path -LiteralPath $nsisDir) "bundle NSIS absent : $nsisDir (lancer sans -SkipBuild)"

  # Filtrer par version : `target/` conserve les bundles des versions
  # precedentes, et `Select-Object -First 1` prenait le plus ancien.
  $installer = Get-ChildItem -LiteralPath $nsisDir -Filter "*_${Version}_*-setup.exe" -File |
    Select-Object -First 1
  if ($null -eq $installer) {
    $present = @(Get-ChildItem -LiteralPath $nsisDir -Filter '*setup.exe' -File | Select-Object -ExpandProperty Name) -join ', '
    Assert ($false) "aucun installateur $Version dans $nsisDir (presents : $present) ; relancer sans -SkipBuild"
  }

  # Updater artifact layout depends on `bundle.createUpdaterArtifacts`:
  #   true           -> the NSIS installer itself, signed as `<installer>.sig`
  #   "v1Compatible" -> an extra `<installer>.nsis.zip` archive, signed as .zip.sig
  # BeeBranch uses `true`, so the installer IS the updater artifact; the .zip
  # is still accepted so an older checkout keeps working.
  $updater = $installer
  $legacy = Get-ChildItem -LiteralPath $nsisDir -File |
    Where-Object { $_.Name -like '*.nsis.zip' } |
    Select-Object -First 1
  if ($null -ne $legacy) { $updater = $legacy }

  $signature = "$($updater.FullName).sig"
  if (-not (Test-Path -LiteralPath $signature)) {
    $produced = @(Get-ChildItem -LiteralPath $nsisDir -File | Select-Object -ExpandProperty Name) -join ', '
    # Single-quoted here-string on purpose: it must never expand a secret.
    $hint = @'
Tauri ne signe l'artefact d'update que si TAURI_SIGNING_PRIVATE_KEY est
defini au moment du build. Verifier dans la meme session PowerShell :
  $env:TAURI_SIGNING_PRIVATE_KEY.Length
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
puis relancer sans -SkipBuild.
'@
    throw "signature d'update manquante : $(Split-Path -Leaf $signature)`ncontenu de ${nsisDir} : $produced`n`n$hint"
  }
  # Un bundle d'une autre version dans le dossier serait televerse dans la
  # release : le signaler plutot que de le publier en silence.
  $others = @(Get-ChildItem -LiteralPath $nsisDir -File |
    Where-Object { $_.Name -like '*-setup.exe' -and $_.Name -ne $installer.Name })
  if ($others.Count -gt 0) {
    Warn "bundles d'autres versions ignores : $(($others | Select-Object -ExpandProperty Name) -join ', ')"
  }

  [pscustomobject]@{
    Directory = $nsisDir
    Installer = $installer
    Updater = $updater
    Assets = @(
      $installer.FullName
      if ($updater.FullName -ne $installer.FullName) { $updater.FullName }
      "$($updater.FullName).sig"
    )
  }
}

$repoRootMarker = Join-Path $script:root 'src-tauri/tauri.conf.json'
Assert (Test-Path -LiteralPath $repoRootMarker) "src-tauri/tauri.conf.json introuvable depuis $($script:root)"

# --- 1. version, tag, etat du depot ----------------------------------------
Step 'Version, tag et etat du depot'

Assert-Command 'git', 'node', 'npm'

$tauriConfig = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
$packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json

if (-not $Version) { $Version = $tauriConfig.version }
Assert ($Version -match '^\d+\.\d+\.\d+$') "version invalide : '$Version'"
if (-not $Tag) { $Tag = "v$Version" }
Assert ($Tag -eq "v$Version") "le tag '$Tag' ne correspond pas a la version '$Version'"

$cargoToml = Get-Content -LiteralPath 'Cargo.toml' -Raw
$workspaceBlock = [regex]::Match($cargoToml, '(?ms)^\[workspace\.package\](?<body>.*?)(?=^\[|\z)')
Assert ($workspaceBlock.Success) 'section [workspace.package] absente de Cargo.toml'
$cargoVersion = [regex]::Match($workspaceBlock.Groups['body'].Value, 'version\s*=\s*"(?<v>[^"]+)"').Groups['v'].Value

Assert ($tauriConfig.version -eq $Version) "tauri.conf.json annonce $($tauriConfig.version), pas $Version"
Assert ($packageJson.version -eq $Version) "package.json annonce $($packageJson.version), pas $Version"
Assert ($cargoVersion -eq $Version) "Cargo.toml annonce $cargoVersion, pas $Version"
Assert (Test-Path -LiteralPath "docs/releases/$Version.md") "notes de version absentes : docs/releases/$Version.md"
Note "version $Version, tag $Tag"

$head = (& git rev-parse HEAD).Trim()
Assert-LastExit 'git rev-parse HEAD'
$tagCommit = (& git rev-parse --verify "$Tag^{commit}" 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $tagCommit) { throw "tag $Tag introuvable : git fetch --tags" }
Assert ($head -eq $tagCommit.Trim()) "HEAD ($head) n'est pas le tag $Tag ($($tagCommit.Trim())) : git checkout $Tag"
Note "HEAD = $Tag = $($head.Substring(0, 10))"

$remoteTag = (& git ls-remote --tags origin "refs/tags/$Tag" 2>$null)
if (-not $remoteTag) {
  Warn "le tag $Tag n'existe pas sur origin : git push origin $Tag (le build ne serait pas reproductible)"
}

if (-not $SkipCleanCheck) {
  $dirty = @(& git status --porcelain)
  Assert-LastExit 'git status --porcelain'
  Assert ($dirty.Count -eq 0) "arbre de travail non propre :`n$($dirty -join "`n")"
  Note 'arbre de travail propre'
}

# --- 2. credentials et endpoint --------------------------------------------
Step 'Credentials de signature et endpoint de mise a jour'

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  Assert (Test-Path -LiteralPath $KeyFile) "cle de signature introuvable : $KeyFile"
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -and (Test-Path -LiteralPath $PasswordFile)) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
}
Assert ([bool]$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) "mot de passe de la cle absent : $PasswordFile ou TAURI_SIGNING_PRIVATE_KEY_PASSWORD"

if (-not $env:BEEBRANCH_UPDATE_ENDPOINT) {
  $env:BEEBRANCH_UPDATE_ENDPOINT = if ($Endpoint) { $Endpoint } else { "https://github.com/$Repo/releases/latest/download/latest.json" }
}
Assert ($env:BEEBRANCH_UPDATE_ENDPOINT -like 'https://*') "endpoint non HTTPS : $($env:BEEBRANCH_UPDATE_ENDPOINT)"
Assert ($env:BEEBRANCH_UPDATE_ENDPOINT -like '*github.com/*/releases/latest/download/latest.json') 'endpoint inattendu : les clients ne trouveraient pas latest.json'
Note "endpoint compile : $($env:BEEBRANCH_UPDATE_ENDPOINT)"
Note 'cle minisign : fournie (contenu jamais affiche)'

# --- 3. build --------------------------------------------------------------
if ($SkipBuild) {
  Step 'Build saute (-SkipBuild)'
} else {
  Step 'Build du bundle NSIS'
  Assert $isWindowsHost 'la compilation Windows exige Windows (utiliser -SkipBuild pour reutiliser un bundle existant)'
  Assert ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') "architecture $($env:PROCESSOR_ARCHITECTURE) : seul windows-x86_64 est publie"

  $nodeMajor = [int]((& node --version).Trim().TrimStart('v').Split('.')[0])
  Assert ($nodeMajor -ge 20) "node $nodeMajor trop ancien (la CI utilise 22)"
  Assert-Command 'cargo', 'rustc'

  # Les artefacts du build precedent restent dans target/ : ils seraient
  # choisis a la place des nouveaux, et televerses dans la release.
  $nsisDir = 'target/release/bundle/nsis'
  if (Test-Path -LiteralPath $nsisDir) {
    $stale = @(Get-ChildItem -LiteralPath $nsisDir -File |
      Where-Object { $_.Name -match '_\d+\.\d+\.\d+_' -and $_.Name -notmatch "_$([regex]::Escape($Version))_" })
    foreach ($file in $stale) { Remove-Item -LiteralPath $file.FullName -Force }
    if ($stale.Count -gt 0) {
      Note "bundles d'autres versions supprimes : $(($stale | Select-Object -ExpandProperty Name) -join ', ')"
    }
  }

  Invoke-Checked 'npm ci' { npm ci }
  Invoke-Checked 'npm run build' { npm run build }
  Invoke-Checked 'audit telemetrie' { node scripts/audit-no-telemetry.mjs }
  Invoke-Checked 'tauri build' { npm run tauri build -- --bundles nsis }
}

# --- 4. artefacts et signature --------------------------------------------
Step 'Verification des artefacts et de la signature minisign'

$bundle = Get-BundleArtifacts
Note "installateur : $($bundle.Installer.Name)"
Note "update       : $($bundle.Updater.Name) ($([math]::Round($bundle.Updater.Length / 1MB, 1)) Mo)"

Invoke-Checked 'verification de la signature' { node scripts/verify-update-signature.mjs $bundle.Updater.FullName }

if ($isWindowsHost) {
  $signature = Get-AuthenticodeSignature -LiteralPath $bundle.Installer.FullName
  if ($signature.Status -eq 'Valid') {
    Note "signature Authenticode : $($signature.SignerCertificate.Subject)"
  } else {
    Warn "installateur non signe ($($signature.Status)) : SmartScreen avertira les utilisateurs"
  }
}

# --- 5. installation silencieuse ------------------------------------------
if ($SkipSmoke) {
  Step 'Installation de controle sautee (-SkipSmoke)'
} elseif (-not $isWindowsHost) {
  throw 'installation de controle impossible hors Windows : ajouter -SkipSmoke'
} else {
  Step 'Installation silencieuse et --version'

  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  if (-not $isAdmin) { Warn "shell non eleve : l'installateur perMachine va demander une elevation UAC" }

  $installRoot = Join-Path $env:TEMP ("beebranch-smoke-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  try {
    $process = Start-Process -FilePath $bundle.Installer.FullName -ArgumentList '/S', "/D=$installRoot" -Wait -PassThru
    Assert ($process.ExitCode -eq 0) "installateur : code $($process.ExitCode)"

    $binary = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter 'BeeBranch.exe' -File | Select-Object -First 1
    Assert ($null -ne $binary) "BeeBranch.exe absent de $installRoot"
    & $binary.FullName --version
    Assert-LastExit 'BeeBranch.exe --version'

    $uninstaller = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter 'uninstall*.exe' -File | Select-Object -First 1
    if ($null -ne $uninstaller) {
      Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait | Out-Null
    }
  } finally {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Note 'binaire installe, lance, puis desinstalle'
}

# --- 6. manifeste ----------------------------------------------------------
Step 'Fragments et manifeste latest.json'

$fragmentsDir = 'target/update/fragments'
if (Test-Path -LiteralPath $fragmentsDir) { Remove-Item -LiteralPath $fragmentsDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $fragmentsDir | Out-Null

$baseUrl = "https://github.com/$Repo/releases/download/$Tag"
$notesPath = "docs/releases/$Version.md"

Invoke-Checked 'fragment windows-x86_64' {
  node scripts/update-manifest.mjs --dir $bundle.Directory --target windows-x86_64 `
    --version $Version --base-url $baseUrl --notes $notesPath `
    --out "$fragmentsDir/windows-x86_64.json"
}

$publishedManifest = 'target/update/published/latest.json'
New-Item -ItemType Directory -Force -Path 'target/update/published' | Out-Null
$publishedUrl = "https://github.com/$Repo/releases/latest/download/latest.json"
try {
  Invoke-WebRequest -Uri $publishedUrl -OutFile $publishedManifest
} catch {
  throw "manifeste publie introuvable ($publishedUrl) : $($_.Exception.Message)"
}
$published = Get-Content -LiteralPath $publishedManifest -Raw | ConvertFrom-Json
Note "manifeste publie : version $($published.version), platforms $(@($published.platforms.PSObject.Properties.Name) -join ', ')"

if ($published.version -eq $Version) {
  # Drop any stale windows entry so the new fragment is the only source of
  # truth, regardless of the order merge-manifests reads the directory in.
  if ($published.platforms.PSObject.Properties.Name -contains 'windows-x86_64') {
    $published.platforms.PSObject.Properties.Remove('windows-x86_64')
    Note 'entree windows-x86_64 precedente remplacee'
  }
  Write-Utf8NoBom "$fragmentsDir/previous.json" ($published | ConvertTo-Json -Depth 20)
} elseif ($AllowVersionMismatch) {
  Warn "le manifeste publie est en $($published.version) : seul windows-x86_64 sera servi pour $Version"
} else {
  throw @"
le manifeste publie est en $($published.version), pas $Version.
Ce script rattrape une plateforme manquante d'une release deja publiee ;
une nouvelle version doit passer par le tag et release.yml. Utiliser
-AllowVersionMismatch pour publier un manifeste windows uniquement.
"@
}

Invoke-Checked 'fusion des fragments' {
  node scripts/merge-manifests.mjs --dir $fragmentsDir --version $Version --notes $notesPath `
    --out target/update/latest.json
}

$merged = Get-Content -LiteralPath 'target/update/latest.json' -Raw | ConvertFrom-Json
$platforms = @($merged.platforms.PSObject.Properties.Name)
Assert ($merged.version -eq $Version) "manifeste fusionne en $($merged.version), pas $Version"
Assert ($platforms -contains 'windows-x86_64') 'windows-x86_64 absent du manifeste fusionne'
foreach ($platform in $platforms) {
  $url = $merged.platforms.$platform.url
  Assert ($url -like "https://github.com/$Repo/releases/download/$Tag/*") "URL hors release $Tag pour ${platform} : $url"
  Assert ([bool]$merged.platforms.$platform.signature) "signature vide pour $platform"
}
$windowsUrl = $merged.platforms.'windows-x86_64'.url
Assert ($windowsUrl -eq "$baseUrl/$($bundle.Updater.Name)") "le manifeste pointe sur $windowsUrl au lieu du nouvel artefact"

foreach ($platform in 'darwin-aarch64', 'linux-x86_64') {
  if ($platforms -notcontains $platform) { Warn "aucune entree $platform : les clients de cette plateforme ne verront pas $Version" }
}
Note "platforms publiees : $($platforms -join ', ')"
Note 'rollback.json inchange'

# --- 7. publication --------------------------------------------------------
Step 'Publication sur le depot de release'

$assets = @($bundle.Assets)
foreach ($asset in $assets) { Note "asset : $(Split-Path -Leaf $asset)" }

if ($NoUpload) {
  Note 'publication sautee (-NoUpload), commandes a jouer :'
  Write-Host "    gh release upload $Tag --repo $Repo $($assets -join ' ') --clobber"
  Write-Host "    gh release upload $Tag --repo $Repo target/update/latest.json --clobber"
  return
}

Assert-Command 'gh'
Invoke-Checked 'gh auth status' { gh auth status }

$canPush = (& gh api "repos/$Repo" --jq '.permissions.push' 2>$null | Out-String).Trim()
Assert-LastExit "lecture des droits sur $Repo"
Assert ($canPush -eq 'true') "le compte gh n'a pas le droit d'ecrire dans $Repo"

$releaseJson = (& gh release view $Tag --repo $Repo --json tagName,isDraft,isPrerelease 2>$null | Out-String)
Assert-LastExit "release $Tag introuvable dans $Repo"
$release = $releaseJson | ConvertFrom-Json
Assert (-not $release.isDraft) "la release $Tag est un brouillon : elle ne serait jamais servie en latest"
Assert (-not $release.isPrerelease) "la release $Tag est une prerelease : elle ne serait jamais servie en latest"

Invoke-Checked 'envoi des artefacts' { gh release upload $Tag --repo $Repo @assets --clobber }
Note 'artefacts envoyes ; envoi du manifeste en dernier'
Invoke-Checked 'envoi du manifeste' { gh release upload $Tag --repo $Repo 'target/update/latest.json' --clobber }

# --- 8. controle -----------------------------------------------------------
Step 'Controle du manifeste publie'

# `releases/latest/download/<asset>` est servi par un CDN : juste apres un
# `--clobber`, l'ancien manifeste peut encore sortir du cache pendant quelques
# minutes. Un parametre de requete force un objet distinct (donc non cache), et
# on retente jusqu'a 5 minutes avant de conclure.
$live = $null
$deadline = (Get-Date).AddMinutes(5)
for ($attempt = 1; ; $attempt++) {
  $probeUrl = "${publishedUrl}?check=$attempt-$(Get-Date -UFormat %s)"
  try {
    $candidate = Invoke-RestMethod -Uri $probeUrl -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 30
  } catch {
    $candidate = $null
  }
  if ($null -ne $candidate -and
      $candidate.version -eq $Version -and
      (@($candidate.platforms.PSObject.Properties.Name) -contains 'windows-x86_64')) {
    $live = $candidate
    break
  }
  if ((Get-Date) -ge $deadline) {
    $seen = if ($null -eq $candidate) {
      'aucune reponse'
    } else {
      "version $($candidate.version), platforms $(@($candidate.platforms.PSObject.Properties.Name) -join ', ')"
    }
    throw @"
le latest.json servi ne contient pas windows-x86_64 pour $Version apres 5 min.
derniere reponse vue : $seen
URL interrogee : $publishedUrl
Verifier l'asset du manifeste sur la release :
  gh release view $Tag --repo $Repo --json assets
"@
  }
  Note "manifeste encore en cache (essai $attempt), nouvelle tentative dans 10 s"
  Start-Sleep -Seconds 10
}

Assert ($live.version -eq $Version) "le latest.json servi annonce $($live.version), pas $Version"
$liveUrl = $live.platforms.'windows-x86_64'.url
Assert ($liveUrl -eq $windowsUrl) "le latest.json servi pointe sur $liveUrl"

try {
  $probe = Invoke-WebRequest -Uri $liveUrl -Method Head -MaximumRedirection 5
  Assert ($probe.StatusCode -eq 200) "telechargement de $liveUrl : HTTP $($probe.StatusCode)"
  $remoteLength = [int64]$probe.Headers['Content-Length']
  Assert ($remoteLength -eq $bundle.Updater.Length) "taille publiee $remoteLength octets, artefact local $($bundle.Updater.Length)"
  Note "artefact joignable ($([math]::Round($remoteLength / 1MB, 1)) Mo)"
} catch {
  Warn "verification du telechargement impossible : $($_.Exception.Message)"
}

Write-Host ''
Write-Host "BeeBranch $Version : Windows publie." -ForegroundColor Green
Note "installateur : https://github.com/$Repo/releases/download/$Tag/$($bundle.Installer.Name)"
Note "les clients Windows en $Version doivent telecharger cet installateur a la main ;"
Note "l'auto-update Windows prend effet a partir de la version suivante."
Note 'supprimer la cle privee de cette machine si elle y a ete copiee.'
