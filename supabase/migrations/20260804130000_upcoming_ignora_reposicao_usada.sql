-- Reposição já lançada para de pedir confirmação de presença ao aluno.
--
-- Regressão que EU introduzi em 0bd4053. Antes, o LessonLauncher APAGAVA a linha
-- de `reschedules` depois de lançar a aula; com a linha fora do banco, ela sumia
-- de `upcoming_classes` e nenhuma confirmação era enfileirada. Troquei o DELETE
-- por marcar `used_at` (para preservar o `fault_type`, que decide se a reposição
-- paga) — e não percebi que a view continua lendo TODAS as reposições:
--
--     FROM reschedules r WHERE r."time" ~ '^[0-9]{2}:[0-9]{2}$'
--
-- Sem filtro de `used_at`, sem checar se já existe class_log.
--
-- O estrago que isso causaria: `enqueue_attendance_confirmations` mandaria ao
-- aluno um "a aula aconteceu?" de aula JÁ lançada. Se ele respondesse que não,
-- `reconcile_attendance_confirmation` marcaria CONFLICT e `payment_hold = true`
-- — ou seja, a correção que fiz para preservar a prova de quem faltou acabaria
-- travando o pagamento de aula legítima.
--
-- Ainda não aconteceu: nenhuma das 98 reposições tem `used_at` preenchido, o que
-- significa que nenhuma foi lançada desde que a mudança subiu (03:01 de hoje).
-- Apontado por outra sessão antes de virar incidente.
--
-- ⚠️ `used_at IS NULL` e não `NOT used_at IS NOT NULL`: a coluna nasce nula em
-- todas as linhas antigas, e elas devem continuar aparecendo — o filtro só tira
-- o que foi de fato consumido.

DO $migration$
DECLARE
  v_def text;
  v_old text := 'WHERE r."time" ~ ''^[0-9]{2}:[0-9]{2}$''::text';
  v_new text := 'WHERE r."time" ~ ''^[0-9]{2}:[0-9]{2}$''::text AND r.used_at IS NULL';
BEGIN
  SELECT pg_get_viewdef('public.upcoming_classes'::regclass, true) INTO v_def;
  IF v_def IS NULL THEN RAISE EXCEPTION 'upcoming_classes não encontrada'; END IF;

  IF position('r.used_at IS NULL' IN v_def) > 0 THEN
    RAISE NOTICE 'upcoming_classes já ignora reposição usada';
    RETURN;
  END IF;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'filtro de reposição não encontrado em upcoming_classes — revise antes de aplicar';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.upcoming_classes AS ' || replace(v_def, v_old, v_new);

  SELECT pg_get_viewdef('public.upcoming_classes'::regclass, true) INTO v_def;
  IF position('r.used_at IS NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'o filtro de used_at não foi aplicado';
  END IF;
END
$migration$;
