param(
    [string]$Token = $(if ($env:TELEGRAM_BOT_TOKEN) { $env:TELEGRAM_BOT_TOKEN } else { "8668769747:AAFFKofq4oKS2pXjeHrcm2mfqANCXIJbDD0" }),
    [string]$Domain = $(if ($env:VERCEL_DOMAIN) { $env:VERCEL_DOMAIN } else { "ian-carpentry.vercel.app" })
)

if (-not $Token) {
    Write-Host "Error: TELEGRAM_BOT_TOKEN not set" -ForegroundColor Red
    exit 1
}

if (-not $Domain) {
    Write-Host "Error: VERCEL_DOMAIN not set" -ForegroundColor Red
    exit 1
}

$WebhookUrl = "https://$Domain/api/telegram-webhook"

Write-Host "Setting Telegram webhook to: $WebhookUrl" -ForegroundColor Cyan
Write-Host ""

$url = "https://api.telegram.org/bot$Token/setWebhook?url=$WebhookUrl"

try {
    $response = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing
    $content = $response.Content | ConvertFrom-Json

    if ($content.ok -eq $true) {
        Write-Host "Webhook set successfully!" -ForegroundColor Green
        Write-Host "Response: $($content.description)"
    } else {
        Write-Host "Failed: $($content.description)" -ForegroundColor Red
        Write-Host "Error code: $($content.error_code)"
    }
} catch {
    Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "Verifying webhook..." -ForegroundColor Cyan

$verifyUrl = "https://api.telegram.org/bot$Token/getWebhookInfo"
$verifyResponse = Invoke-WebRequest -Uri $verifyUrl -Method Get -UseBasicParsing
$verifyContent = $verifyResponse.Content | ConvertFrom-Json

if ($verifyContent.ok -eq $true) {
    $info = $verifyContent.result
    Write-Host "URL: $($info.url)"
    Write-Host "Has custom cert: $($info.has_custom_certificate)"
    Write-Host "Pending updates: $($info.pending_update_count)"
}

Write-Host ""
Write-Host "Done! Ian Carpentry Bot webhook configured." -ForegroundColor Green
