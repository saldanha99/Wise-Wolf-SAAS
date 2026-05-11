
# Deploy Database Migrations
# This applies the RLS Fixes and the New Group Column

Write-Host "Iniciando atualizacao do Banco de Dados..." -ForegroundColor Cyan

# 1. Pushing Migrations (Applies local .sql files to remote Supabase)
Write-Host "Enviando correcoes de permissao (RLS) e colunas..." -ForegroundColor Yellow
npx supabase db push

if ($LASTEXITCODE -eq 0) {
    Write-Host "Banco de Dados Atualizado com Sucesso!" -ForegroundColor Green
    Write-Host "Agora atualize a pagina 'Automacao Smart' (F5)." -ForegroundColor White
}
else {
    Write-Host "Erro ao atualizar Banco de Dados." -ForegroundColor Red
    Write-Host "Tente rodar 'npx supabase login' se o erro for de autenticacao." -ForegroundColor Gray
}

Read-Host -Prompt "Pressione Enter para sair"
