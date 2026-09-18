<#
.SYNOPSIS
  Moves downloaded project files into the repository folder structure.

.DESCRIPTION
  Files arrive from chat as a flat list. This script matches each one by
  name, creates the target folders and moves it there. Duplicates such as
  "styles (1).css" are recognised as "styles.css". Files not listed in the
  mapping table are left untouched.

.NOTES
  ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files in the
  system code page, so non-ASCII text without a UTF-8 BOM breaks parsing.
  Works on Windows PowerShell 5.1 and PowerShell 7.

  The file comes from the internet, so unblock it first:
      Unblock-File .\scripts\place-files.ps1

.EXAMPLE
  .\scripts\place-files.ps1 -From "$HOME\Downloads" -WhatIf
  .\scripts\place-files.ps1 -From "$HOME\Downloads"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$From = "$HOME\Downloads",
  [string]$To
)

if (-not $To) {
  if ($PSScriptRoot) { $To = Split-Path $PSScriptRoot -Parent }
  else               { $To = (Get-Location).Path }
}

$map = @{
  # repository root
  'README.md' = '.'; 'CLAUDE.md' = '.'; 'CHANGELOG.md' = '.'
  '.env.example' = '.'; '.gitignore' = '.'

  # documentation
  'API.md' = 'docs'; 'ARCHITECTURE.md' = 'docs'; 'DATA_MODEL.md' = 'docs'
  'DECISIONS.md' = 'docs'; 'ROADMAP.md' = 'docs'; 'SETUP.md' = 'docs'
  'TESTING.md' = 'docs'; 'DEPLOY.md' = 'docs'

  # database migrations
  '20260910120000_init.sql'   = 'supabase\migrations'
  '20260910120100_rls.sql'    = 'supabase\migrations'
  '20260910120200_rpc.sql'    = 'supabase\migrations'
  '20260910120300_grants.sql' = 'supabase\migrations'
  '20260911100000_items_page_fix.sql' = 'supabase\migrations'
  '20260916220000_revoke_default_function_grants.sql' = 'supabase\migrations'

  'seed.sql' = 'supabase'

  # database tests (pgTAP)
  '01_schema_guards.test.sql' = 'supabase\tests\database'
  '02_owner_isolation.test.sql' = 'supabase\tests\database'
  '03_sharing_and_reservations.test.sql' = 'supabase\tests\database'

  # auth email templates (uk + pl)
  'confirmation.html' = 'supabase\templates'; 'recovery.html' = 'supabase\templates'
  'invite.html' = 'supabase\templates'; 'password_changed.html' = 'supabase\templates'

  # frontend root
  'index.html' = 'app'; 'package.json' = 'app'; 'tsconfig.json' = 'app'
  'tsconfig.test.json' = 'app'; 'vercel.json' = 'app'
  'vite.config.ts' = 'app'; 'playwright.config.ts' = 'app'

  # frontend source
  'main.tsx' = 'app\src'; 'App.tsx' = 'app\src'
  'styles.css' = 'app\src'; 'vite-env.d.ts' = 'app\src'

  'supabase.ts' = 'app\src\lib'; 'auth.tsx' = 'app\src\lib'
  'theme.tsx' = 'app\src\lib'; 'i18n.tsx' = 'app\src\lib'
  'authErrors.ts' = 'app\src\lib'; 'db.ts' = 'app\src\lib'
  'types.ts' = 'app\src\lib'; 'format.ts' = 'app\src\lib'
  'useItems.ts' = 'app\src\lib'

  'uk.json' = 'app\src\i18n'; 'pl.json' = 'app\src\i18n'; 'en.json' = 'app\src\i18n'

  'RequireAuth.tsx' = 'app\src\components'; 'AppShell.tsx' = 'app\src\components'
  'AuthLayout.tsx'  = 'app\src\components'; 'ui.tsx'       = 'app\src\components'
  'Dialog.tsx' = 'app\src\components'; 'ItemCard.tsx' = 'app\src\components'
  'ItemDialog.tsx' = 'app\src\components'; 'ListDialog.tsx' = 'app\src\components'
  'Toolbar.tsx' = 'app\src\components'; 'ShareDialog.tsx' = 'app\src\components'
  'LocaleSync.tsx' = 'app\src\components'; 'LanguagePicker.tsx' = 'app\src\components'
  'UpdatePrompt.tsx' = 'app\src\components'; 'install.ts' = 'app\src\lib'; 'errors.ts' = 'app\src\lib'
  'EventSummary.tsx' = 'app\src\components'; 'env-local.mjs' = 'app\scripts'
  'ExportDialog.tsx' = 'app\src\components'; 'ImportDialog.tsx' = 'app\src\components'
  'transfer.ts' = 'app\src\lib'; 'download.ts' = 'app\src\lib'
  'cache.ts' = 'app\src\lib'; 'StaleNotice.tsx' = 'app\src\components'
  'transfer.spec.ts' = 'app\tests\e2e'
  'check-pwa.mjs' = 'app\scripts'; 'generate-icons.mjs' = 'app\scripts'
  'icon.svg' = 'app\public\icons'; 'maskable.svg' = 'app\public\icons'
  'icon-192.png' = 'app\public\icons'; 'icon-512.png' = 'app\public\icons'
  'maskable-512.png' = 'app\public\icons'; 'apple-touch-icon.png' = 'app\public\icons'

  'Login.tsx' = 'app\src\routes'; 'Register.tsx' = 'app\src\routes'
  'ResetPassword.tsx' = 'app\src\routes'; 'UpdatePassword.tsx' = 'app\src\routes'
  'Lists.tsx' = 'app\src\routes'; 'Settings.tsx' = 'app\src\routes'
  'NotFound.tsx' = 'app\src\routes'; 'ListDetail.tsx' = 'app\src\routes'
  'Shares.tsx' = 'app\src\routes'; 'SharedList.tsx' = 'app\src\routes'

  'database.ts' = 'app\src\types'
  'auth.spec.ts' = 'app\tests\e2e'; 'items.spec.ts' = 'app\tests\e2e'
  'sharing.spec.ts' = 'app\tests\e2e'
  'parser.ts' = 'app\src\lib'; 'guest.ts' = 'app\src\lib'
  'shares.ts' = 'app\src\lib'; 'safeNext.ts' = 'app\src\lib'
  'safe-next.spec.ts' = 'app\tests\e2e'; 'helpers.ts' = 'app\tests\e2e'
  'session.spec.ts' = 'app\tests\e2e'; 'global-setup.ts' = 'app\tests'

  # parser service
  'requirements.txt' = 'services\parser'; 'requirements-dev.txt' = 'services\parser'
  'Dockerfile' = 'services\parser'; 'docker-compose.yml' = 'services\parser'
  'pytest.ini' = 'services\parser'
  '__init__.py' = 'services\parser\app'; 'config.py' = 'services\parser\app'
  'models.py' = 'services\parser\app';  'auth.py' = 'services\parser\app'
  'fetcher.py' = 'services\parser\app';  'extract.py' = 'services\parser\app'
  'cache.py' = 'services\parser\app';    'ratelimit.py' = 'services\parser\app'
  'main.py' = 'services\parser\app'
  'test_extract.py' = 'services\parser\tests'; 'test_ssrf.py' = 'services\parser\tests'
  'test_auth.py' = 'services\parser\tests'; 'test_fetch_pinning.py' = 'services\parser\tests'
  'jsonld.html' = 'services\parser\tests\fixtures'; 'og.html' = 'services\parser\tests\fixtures'
  'microdata.html' = 'services\parser\tests\fixtures'; 'bare.html' = 'services\parser\tests\fixtures'
  'price_in_text.html' = 'services\parser\tests\fixtures'
  'ikea_like.html' = 'services\parser\tests\fixtures'
}

if (-not (Test-Path $From)) {
  throw "Source folder not found: $From"
}

Write-Host "From: $From"
Write-Host "To:   $To"
Write-Host ""

$moved = 0

Get-ChildItem -Path $From -File | ForEach-Object {
  # "styles (1).css" -> "styles.css"
  $name = $_.Name -replace '\s\(\d+\)(?=\.[^.]+$)', ''

  if ($map.ContainsKey($name)) {
    $destDir = Join-Path $To $map[$name]
    if (-not (Test-Path $destDir)) {
      New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    $dest = Join-Path $destDir $name
    if ($PSCmdlet.ShouldProcess($dest, 'Move')) {
      Move-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
    Write-Host ("  {0,-28} -> {1}" -f $name, $map[$name])
    $moved++
  }
}

Write-Host ""
Write-Host "Matched: $moved" -ForegroundColor Green

$missing = @()
foreach ($key in $map.Keys) {
  $full = Join-Path $To (Join-Path $map[$key] $key)
  if (-not (Test-Path $full)) { $missing += $key }
}

if ($missing.Count -gt 0) {
  Write-Host "Still missing in the repo:" -ForegroundColor Yellow
  $missing | Sort-Object | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "All expected files are in place." -ForegroundColor Green
}
