-- Convite de cobertura recusado/cancelado não pode bloquear a próxima cobertura
-- da MESMA aula.
--
-- O caso (18/09/2026, Theo/Flávio/Bruna): o convite de sexta 09:30 foi
-- cancelado em 17/09 (WhatsApp central restrito, link não entregue), com o
-- combinado de a direção atestar a aula pelo grupo depois de dada. O atestado
-- (`gestao_create_coverage_invite`, ramo retroativo) morreu em
--   duplicate key value violates unique constraint
--   "class_coverages_booking_id_class_date_key"
-- porque a UNIQUE (booking_id, class_date) — criada fora do repositório — vale
-- para linha cancelada também. Pelo mesmo motivo, professor que RECUSA um
-- convite deixa a aula sem poder ser oferecida a outro.
--
-- Quem garante "uma cobertura viva por aula" é o trigger
-- `enforce_active_class_coverage_slot` (`active_coverage_slot_conflict`, que
-- já considera pendente vencida como morta). A unicidade física fica só para
-- a cobertura que valeu: confirmada (e os status legados do fluxo antigo).

alter table public.class_coverages
  drop constraint if exists class_coverages_booking_id_class_date_key;

create unique index if not exists class_coverages_live_booking_date_uidx
  on public.class_coverages (booking_id, class_date)
  where lower(status) in ('confirmed', 'scheduled', 'completed');

comment on index public.class_coverages_live_booking_date_uidx is
  'Uma cobertura CONFIRMADA por aula (booking + data). Pendente, recusada e cancelada não bloqueiam a próxima — o trigger enforce_active_class_coverage_slot cuida das vivas.';
