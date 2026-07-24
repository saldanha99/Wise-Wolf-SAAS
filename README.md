<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Wise Wolf SaaS

## Executar localmente

**Pré-requisito:** Node.js

1. Instale as dependências com `npm install`.
2. Copie `.env.example` para `.env.local` e configure somente
   `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` para o frontend.
3. Execute `npm run dev`.

`GEMINI_API_KEY`, `EVOLUTION_API_KEY` e as demais credenciais privilegiadas
devem existir somente no runtime das Edge Functions. Elas nunca devem receber
o prefixo `VITE_` nem ser injetadas no bundle do navegador.
