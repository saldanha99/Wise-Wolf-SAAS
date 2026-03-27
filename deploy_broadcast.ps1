# Helper script to deploy the Broadcast Opportunity Edge Function
Write-Host "Starting deployment of 'broadcast-opportunity' Edge Function..."
Write-Host "Please ensure you have logged in to Supabase CLI (run 'npx supabase login' if needed)."

cmd /c "npx supabase functions deploy broadcast-opportunity --project-ref dvalxbtngopxopzcbfdm --no-verify-jwt"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deployment Successful!" -ForegroundColor Green
}
else {
    Write-Host "Deployment Failed. Please check the error message above." -ForegroundColor Red
}
Pause
