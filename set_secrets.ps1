# Script para configurar as chaves do Asaas no Supabase
# Execute este arquivo no PowerShell

Write-Host "Configurando chaves do Asaas..."

npx supabase secrets set ASAAS_API_KEY='$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjY4MWZlODRkLTNkMjEtNGVjMi1iNTM2LTZjYjU1MDExNTMzYTo6JGFhY2hfYjA4OWQ3M2QtMDZmNy00ZDAyLTg0MzYtOWRiMjBiZGZjNGZm'
npx supabase secrets set ASAAS_API_URL='https://api-sandbox.asaas.com/v3'

Write-Host "Pronto! Chaves configuradas."
