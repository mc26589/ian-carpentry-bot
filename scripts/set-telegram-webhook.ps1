# נגריית איאן — Set Telegram Webhook (Windows PowerShell)
# Usage:
#   $env:TELEGRAM_BOT_TOKEN="your_token"
#   $env:VERCEL_DOMAIN="your-app.vercel.app"
#   .\scripts\set-telegram-webhook.ps1

param(
    [string]$Token = $env:TELEGRAM_BOT_TOKEN,
    [string]$Domain = $env:VERCEL_DOMAIN
)

if (-not $Token) {
    Write-Host "❌ Error: TELEGRAM_BOT_TOKEN not set" -ForegroundColor Red
    Write-Host "   Usage: Set `$env:TELEGRAM_BOT_TOKEN='xxx' before running"
    exit 1
}

if (-not $Domain) {
    Write-Host "❌ Error: VERCEL_DOMAIN not set" -ForegroundColor Red
    Write-Host "   Usage: Set `$env:VERCEL_DOMAIN='your-app.vercel.app' before running"
    exit 1
}

$WebhookUrl = "https://$Domain/api/telegram-webhook"

Write-Host "🪚 Setting Telegram webhook to: $WebhookUrl" -ForegroundColor Cyan
Write-Host ""

$url = "https://api.telegram.org/bot$Token/setWebhook?url=$WebhookUrl"

try {
    $response = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing
    $content = $response.Content | ConvertFrom-Json

    if ($content.ok -eq $true) {
        Write-Host "✅ Webhook set successfully!" -ForegroundColor Green
        Write-Host "   Response: $($content.description)"
    } else {
        Write-Host "❌ Failed: $($content.description)" -ForegroundColor Red
        Write-Host "   Error code: $($content.error_code)"
    }
} catch {
    Write-Host "❌ Request failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "🔍 Verifying webhook..." -ForegroundColor Cyan

$verifyUrl = "https://api.telegram.org/bot$Token/getWebhookInfo"
$verifyResponse = Invoke-WebRequest -Uri $verifyUrl -Method Get -UseBasicParsing
$verifyContent = $verifyResponse.Content | ConvertFrom-Json

if ($verifyContent.ok -eq $true) {
    $info = $verifyContent.result
    Write-Host "   URL: $($info.url)"
    Write-Host "   Has custom cert: $($info.has_custom_certificate)"
    Write-Host "   Pending updates: $($info.pending_update_count)"
}

Write-Host ""
Write-Host "🪚 Done! Ian's Carpentry Bot is ready." -ForegroundColor Green
