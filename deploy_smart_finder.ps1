# Helper script to deploy Smart Finder Logic (All Functions)

Write-Host "Deploying 'search-slots'..."
cmd /c "npx supabase functions deploy search-slots --project-ref dvalxbtngopxopzcbfdm --no-verify-jwt"

Write-Host "Deploying 'broadcast-opportunity'..."
cmd /c "npx supabase functions deploy broadcast-opportunity --project-ref dvalxbtngopxopzcbfdm --no-verify-jwt"

Write-Host "Deploying 'accept-opportunity'..."
cmd /c "npx supabase functions deploy accept-opportunity --project-ref dvalxbtngopxopzcbfdm --no-verify-jwt"

if ($LASTEXITCODE -eq 0) {
    Write-Host "All Functions Deployed Successfully! 🐺" -ForegroundColor Green
}
else {
    Write-Host "Some deployment failed. Check errors above." -ForegroundColor Red
}
Pause
