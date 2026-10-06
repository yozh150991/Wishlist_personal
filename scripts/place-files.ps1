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
  '20260921100000_item_variants.sql' = 'supabase\migrations'
  '20260921140000_profile_scheme.sql' = 'supabase\migrations'
  '20260928090000_schemes_and_contrast.sql' = 'supabase\migrations'
  '20260928100000_list_appearances.sql' = 'supabase\migrations'
  '20260928110000_guest_keys_and_claims.sql' = 'supabase\migrations'
  '20260928120000_sections_and_order.sql' = 'supabase\migrations'
  '20260928130000_share_expiry_zone.sql' = 'supabase\migrations'
  '20260928140000_owner_side_channels.sql' = 'supabase\migrations'
  '20260928160000_item_drafts.sql' = 'supabase\migrations'
  '20260928170000_yearly_lists.sql' = 'supabase\migrations'
  '20260929090000_link_checks.sql' = 'supabase\migrations'
  '20260930090000_notifications.sql' = 'supabase\migrations'
  '20261006090000_item_currency_and_rates.sql' = 'supabase\migrations'

  'seed.sql' = 'supabase'

  # database tests (pgTAP)
  '01_schema_guards.test.sql' = 'supabase\tests\database'
  '02_owner_isolation.test.sql' = 'supabase\tests\database'
  '03_sharing_and_reservations.test.sql' = 'supabase\tests\database'
  '04_item_variants.test.sql' = 'supabase\tests\database'
  '05_appearance.test.sql' = 'supabase\tests\database'
  '06_sections.test.sql' = 'supabase\tests\database'
  '07_share_expiry.test.sql' = 'supabase\tests\database'
  '08_owner_side_channels.test.sql' = 'supabase\tests\database'
  '09_item_drafts.test.sql' = 'supabase\tests\database'
  '10_yearly_lists.test.sql' = 'supabase\tests\database'
  '11_link_checks.test.sql' = 'supabase\tests\database'
  '12_notifications.test.sql' = 'supabase\tests\database'
  '13_item_currency.test.sql' = 'supabase\tests\database'

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
  'ShareDialog.tsx' = 'app\src\components'
  'LocaleSync.tsx' = 'app\src\components'; 'LanguagePicker.tsx' = 'app\src\components'
  'UpdatePrompt.tsx' = 'app\src\components'; 'install.ts' = 'app\src\lib'; 'errors.ts' = 'app\src\lib'
  'EventSummary.tsx' = 'app\src\components'; 'env-local.mjs' = 'app\scripts'
  'ExportDialog.tsx' = 'app\src\components'; 'ImportDialog.tsx' = 'app\src\components'
  'transfer.ts' = 'app\src\lib'; 'download.ts' = 'app\src\lib'
  'VariantsField.tsx' = 'app\src\components'
  'cache.ts' = 'app\src\lib'
  'idb.ts' = 'app\src\lib'; 'outbox.ts' = 'app\src\lib'; 'outboxOps.ts' = 'app\src\lib'
  'outbox.spec.ts' = 'app\tests\e2e'
  'robots.txt' = 'app\public'

  # Redesign (ADR-031): tokens, icons, banners, filters, appearance.
  'tokens.css' = 'app\src\styles'
  'check-contrast.mjs' = 'app\scripts'; 'check-i18n.mjs' = 'app\scripts'
  'Icon.tsx' = 'app\src\components'; 'Banners.tsx' = 'app\src\components'
  'Filters.tsx' = 'app\src\components'; 'media.ts' = 'app\src\lib'
  'AppearanceSync.tsx' = 'app\src\components'
  'AppearanceSheet.tsx' = 'app\src\components'
  'transfer.spec.ts' = 'app\tests\e2e'; 'date-text.spec.ts' = 'app\tests\e2e'
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

  # Design version switch (ADR-032). File names here are unique across the
  # whole repository on purpose: this table maps by file name alone, so two
  # files both called Routes.tsx could not be placed.
  'design.spec.ts' = 'app\tests\e2e'
  'DesignRoutes.tsx' = 'app\src\designs'
  'RoutesV1.tsx' = 'app\src\designs\v1'
  'RoutesV2.tsx' = 'app\src\designs\v2'
  'PlaceholderV2.tsx' = 'app\src\designs\v2\screens'
  # Design v2 foundation (ADR-039): lazy v2 styles, /l/ guest route.
  'v2.css' = 'app\src\designs\v2'; 'GuestV2.tsx' = 'app\src\designs\v2\screens'
  # Design v2 sign-in (ADR-042): shared auth helpers and v2 screens.
  'authFlow.ts' = 'app\src\lib'; 'password.ts' = 'app\src\lib'
  'AuthPartsV2.tsx' = 'app\src\designs\v2\screens'; 'LoginV2.tsx' = 'app\src\designs\v2\screens'
  'RegisterV2.tsx' = 'app\src\designs\v2\screens'; 'ResetV2.tsx' = 'app\src\designs\v2\screens'
  'NewPasswordV2.tsx' = 'app\src\designs\v2\screens'; 'auth-v2.spec.ts' = 'app\tests\e2e'
  # Design v2 owner shell and home (step 3a).
  'ShellV2.tsx' = 'app\src\designs\v2'; 'CommonV2.tsx' = 'app\src\designs\v2\screens'
  'ListsV2.tsx' = 'app\src\designs\v2\screens'
  'NewListV2.tsx' = 'app\src\designs\v2\screens'; 'lists-v2.spec.ts' = 'app\tests\e2e'
  # Design v2 list page (step 3b-1, ADR-044): shared pure helpers and v2 screens.
  'itemsView.ts' = 'app\src\lib'; 'order.ts' = 'app\src\lib'; 'dateText.ts' = 'app\src\lib'; 'fx.ts' = 'app\src\lib'
  'undo.ts' = 'app\src\lib'; 'variants.ts' = 'app\src\lib'
  'ListV2.tsx' = 'app\src\designs\v2\screens'; 'ItemSheetV2.tsx' = 'app\src\designs\v2\screens'
  'ListPartsV2.tsx' = 'app\src\designs\v2\screens'; 'list-v2.spec.ts' = 'app\tests\e2e'; 'ImportSheetV2.tsx' = 'app\src\designs\v2\screens'
  'items-view.spec.ts' = 'app\tests\e2e'
  # Design v2 list actions (step 3b-2): share, preview, appearance, settings, order.
  'ShareSheetV2.tsx' = 'app\src\designs\v2\screens'; 'PreviewV2.tsx' = 'app\src\designs\v2\screens'
  'AppearanceSheetV2.tsx' = 'app\src\designs\v2\screens'; 'ListSettingsV2.tsx' = 'app\src\designs\v2\screens'
  'ReorderV2.tsx' = 'app\src\designs\v2\screens'
  # Design v2 step 3c: my links, settings; outbox flushing shared by both designs.
  'SharesV2.tsx' = 'app\src\designs\v2\screens'; 'SettingsV2.tsx' = 'app\src\designs\v2\screens'
  'useOutbox.ts' = 'app\src\lib'
  # Design v2 step 4a: after the event, archive, repeat next year.
  'AfterEventV2.tsx' = 'app\src\designs\v2\screens'; 'afterEvent.ts' = 'app\src\lib'
  'after-event.spec.ts' = 'app\tests\e2e'; 'after-event-v2.spec.ts' = 'app\tests\e2e'
  # Design v2 step 4b: drafts, share target (/add), v1 bridge.
  'AddV2.tsx' = 'app\src\designs\v2\screens'; 'AddBridgeV1.tsx' = 'app\src\designs\v1'
  'shareTarget.ts' = 'app\src\lib'; 'share-target.spec.ts' = 'app\tests\e2e'
  # notifications v2, step 4g-2 (ADR-049)
  'NotifyV2.tsx' = 'app\src\designs\v2\screens'
  'notifications.ts' = 'app\src\lib'; 'notifyRules.ts' = 'app\src\lib'
  'notify-rules.spec.ts' = 'app\tests\e2e'; 'notify-v2.spec.ts' = 'app\tests\e2e'
  'push-sw.js' = 'app\public'

  # Five taste schemes, high contrast, list appearance (ADR-033).
  'appearance.ts' = 'app\src\lib'; 'hue-ramp.js' = 'app\src\lib'
  'hue-ramp.d.ts' = 'app\src\lib'; 'Switch.tsx' = 'app\src\components'
  'appearance.spec.ts' = 'app\tests\e2e'
  'appearances.ts' = 'app\src\lib'; 'AppearanceDialog.tsx' = 'app\src\components'
  'GuestParts.tsx' = 'app\src\components'; 'GuestPreview.tsx' = 'app\src\routes'
  'guest.spec.ts' = 'app\tests\e2e'
  'sections.ts' = 'app\src\lib'; 'SectionsView.tsx' = 'app\src\components'
  'SectionDialog.tsx' = 'app\src\components'; 'sections.spec.ts' = 'app\tests\e2e'
  'thresholds.spec.ts' = 'app\tests\e2e'
  'zones.ts' = 'app\src\lib'; 'expiry.spec.ts' = 'app\tests\e2e'

  # parser service
  'requirements.txt' = 'services\parser'; 'requirements-dev.txt' = 'services\parser'
  'Dockerfile' = 'services\parser'; 'docker-compose.yml' = 'services\parser'
  'pytest.ini' = 'services\parser'
  '__init__.py' = 'services\parser\app'; 'config.py' = 'services\parser\app'
  'models.py' = 'services\parser\app';  'auth.py' = 'services\parser\app'
  'fetcher.py' = 'services\parser\app';  'extract.py' = 'services\parser\app'
  'cache.py' = 'services\parser\app';    'ratelimit.py' = 'services\parser\app'
  'main.py' = 'services\parser\app'
  # closed background jobs service wishlist-jobs (ADR-048), same image
  'jobs_main.py' = 'services\parser\app';  'jobs_config.py' = 'services\parser\app'
  'jobs_store.py' = 'services\parser\app'; 'jobs_links.py' = 'services\parser\app'; 'jobs_rates.py' = 'services\parser\app'
  # owner notifications (ADR-049)
  'jobs_notify.py' = 'services\parser\app'; 'jobs_push.py' = 'services\parser\app'
  'jobs_mail.py' = 'services\parser\app';   'jobs_texts.py' = 'services\parser\app'
  'test_extract.py' = 'services\parser\tests'; 'test_ssrf.py' = 'services\parser\tests'
  'test_auth.py' = 'services\parser\tests'; 'test_fetch_pinning.py' = 'services\parser\tests'
  'test_jobs.py' = 'services\parser\tests'; 'test_notify.py' = 'services\parser\tests'; 'test_rates.py' = 'services\parser\tests'
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
