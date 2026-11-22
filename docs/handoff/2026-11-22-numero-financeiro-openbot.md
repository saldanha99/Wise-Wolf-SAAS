# Tarefa para o OpenBot — número financeiro da Wise Wolf (22/11/2026)

Contexto completo: seção "22/11/2026 — Número só do financeiro no ar" do `CLAUDE.md`.

## Estado quando o Claude parou (≈08:30 BRT de 22/11)
- Instância `saldanha-tenant-06d8fb73-e57c-4e50-a36d-9904cf0e36d0` (Evolution `api.2b.app.br`,
  motofix-vps) **pareada de novo** pelo Vinícius às ~08:25 BRT (o WhatsApp tinha deslogado o
  aparelho às 02:07 BRT, código 401; foi preciso `docker service update --force evolution_evolution_api`).
- `whatsapp_instances.status = 'open'` de novo na VPS da Wise Wolf: a cobrança sai por ele.
- Webhook e settings reaplicados a partir do snapshot
  (`/root/backups/numero-financeiro-wisewolf-20261122/finance-snapshot-before-recreate.json`, motofix-vps).
- Saída dos 35 grupos antigos (W-Tech/MotoFix/cursos), **autorizada pelo Vinícius**, rodando em
  segundo plano no motofix-vps: log em
  `/root/backups/numero-financeiro-wisewolf-20261122/saida-dos-grupos.log` (35 linhas com `200` = pronto).

## O que falta (pedido do Vinícius)
1. **Foto de perfil nova**: imagem quadrada (640×640) que deixe claro que é o *Financeiro da Wise Wolf*,
   com o logo da Wise Wolf (`public/assets/brand/wise-wolf-logo.png`) **e** o logo do Asaas lado a lado,
   texto "Financeiro". Aplicar com `POST /chat/updateProfilePicture/<instância>` `{ "picture": "<url https ou base64>" }`
   e conferir com `POST /chat/fetchProfilePictureUrl/<instância>` (o número da própria instância).
2. Conferir o log da saída dos grupos; repetir `DELETE /group/leaveGroup/<instância>?groupJid=…` só nos que falharam.
3. Conferir que a rodada de cobrança das 09h BRT saiu pela instância financeira
   (`notification_queue.provider_instance_name`) e sem `Connection Closed` nos logs do Evolution.
   Se o aparelho cair de novo (401): marcar a linha `disconnected` (a cobrança volta à central) e avisar o Vinícius.

⚠️ Nunca use esta instância para avisos de outro projeto. Chave da Evolution só de dentro do container (`printenv AUTHENTICATION_API_KEY`).
