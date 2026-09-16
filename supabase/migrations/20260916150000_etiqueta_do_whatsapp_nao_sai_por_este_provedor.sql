-- ─────────────────────────────────────────────────────────────────────────────
-- Etiqueta do WhatsApp: medido, não funciona por este provedor (16/09/2026)
--
-- A automação de etiquetas (migration 20260916140000) foi testada em produção e
-- NÃO aplica etiqueta nenhuma. O que foi medido, para ninguém repetir o caminho:
--
--   • `GET /label/findLabels` funciona e lista as 7 etiquetas da conta (4 da
--     escola + 3 do sistema) — depois de assinar LABELS_EDIT/LABELS_ASSOCIATION
--     no webhook e reconectar a sessão;
--   • `POST /label/handleLabel` responde **200 com `{"add": true}`** para os dois
--     endereçamentos possíveis desta conta (número `55…@s.whatsapp.net` e
--     identificador interno `…@lid`);
--   • o WhatsApp NUNCA devolve o evento `labels.association` dessas chamadas —
--     só devolveu da etiqueta que a direção aplicou à mão no aplicativo;
--   • e, conferido pela direção no aparelho, **nenhuma das quatro conversas de
--     teste recebeu etiqueta**.
--
-- Ou seja: o provedor aceita e mente. Deixar o cron ligado só gastaria chamada e
-- encheria `private.whatsapp_conversation_labels` de registro falso — o banco
-- passaria a dizer "etiquetado" para conversa sem etiqueta nenhuma.
--
-- O cron sai. A tabela e as funções ficam, sem nada chamando: se um dia o
-- provedor corrigir (ou a escola trocar de provedor), é só reagendar. A
-- separação por tipo de contato continua existindo onde sempre esteve:
-- `whatsapp_conversations.contact_kind`.
-- ─────────────────────────────────────────────────────────────────────────────

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'wisewolf-whatsapp-labels') then
    perform cron.unschedule('wisewolf-whatsapp-labels');
  end if;
end $cron$;

comment on table private.whatsapp_conversation_labels is
  'Etiquetas aplicadas por conversa. SEM USO desde 16/09/2026: o provedor de '
  'WhatsApp responde 200 e não aplica a etiqueta (ver migration 20260916150000).';
