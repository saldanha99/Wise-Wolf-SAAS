# Script para configurar as chaves do Asaas no Supabase
# Execute este arquivo no PowerShell

Write-Host "Configurando chaves do Asaas..."

npx supabase secrets set ASAAS_API_KEY='$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmY2MzUyOGU5LWIzMWQtNDc2MS1hOWE2LWQ1ZWY1MTRkMjFmNDo6JGFhY2hfNjQ1MmJlZTktZWNlYy00M2ZkLWE0NTgtMjFjZjFkMTZkOTY0'
npx supabase secrets set ASAAS_API_URL='https://api-sandbox.asaas.com/v3'

Write-Host "Pronto! Chaves configuradas."
