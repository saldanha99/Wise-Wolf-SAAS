-- ─────────────────────────────────────────────────────────────────────────────
-- Aviso para quem tem WhatsApp SEM o 9º dígito era barrado em silêncio (15/09/2026)
--
-- Conta de WhatsApp antiga continua registrada com 12 dígitos (55 + DDD + 8),
-- enquanto o cadastro guarda o celular com 13 (55 + DDD + 9 + 8). A trava de
-- envio compara o destino esperado com o JID que o WhatsApp devolve usando
-- `notification_phones_same_recipient`, e a regra antiga tirava o DDD de
-- `left(right(numero, 10), 2)` — com um dígito a mais de um lado, o corte
-- desloca e a mesma pessoa vira "outra". Resultado: `raise
-- invalid_notification_delivery_submission`, o item fica em preparing até
-- esgotar as tentativas e nada é enviado.
--
-- Medido: 18 agendas diárias (`TEACHER_AGENDA`) não entregues em 14 dias, dois
-- professores com ZERO agendas no período. Grupos (@g.us) não passam por aqui.
--
-- Regra nova: além das comparações antigas (que continuam valendo), celular
-- com o 9 e a forma sem o 9 são a mesma pessoa — mesmo DDD, mesmos 8 dígitos.
-- Só para a faixa clássica de celular (8 dígitos começando com 6–9): fixo
-- começa com 2–5, então tirar o 9 de um celular nunca produz um fixo.
-- Funções que usam a regra: as travas de envio de avisos, de confirmação de
-- pagamento e de aviso de pagamento à Gestão, e o agendamento manual de
-- experimental. `create or replace` preserva dono e permissões.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.notification_phones_same_recipient(p_left text, p_right text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  with normalized as (
    select private.normalize_notification_phone(p_left) as l,
           private.normalize_notification_phone(p_right) as r
  ), canonical as (
    select l, r,
      case when l ~ '^55[1-9][0-9]9[6-9][0-9]{7}$'
        then pg_catalog.left(l, 4) || pg_catalog.right(l, 8) else l end as cl,
      case when r ~ '^55[1-9][0-9]9[6-9][0-9]{7}$'
        then pg_catalog.left(r, 4) || pg_catalog.right(r, 8) else r end as cr
    from normalized
  )
  select case
    when l is null or r is null then false
    when l = r then true
    when cl = cr then true
    else
      pg_catalog.left(pg_catalog.right(l, 10), 2) = pg_catalog.left(pg_catalog.right(r, 10), 2)
      and pg_catalog.right(l, 8) = pg_catalog.right(r, 8)
  end
  from canonical
$function$;
