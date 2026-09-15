-- ─────────────────────────────────────────────────────────────────────────────
-- Lembrete de 30 min antes da aula parado desde 12/09/2026
--
-- `prepare-daily-reminders` (cron a cada 5 min) lê `upcoming_classes` com a
-- service_role. Em 12/09 a view passou a converter a data das reposições com
-- `public.parse_lesson_date` (migration 20260912203137). Só que a migration
-- 20260820091231 tinha revogado essa função de todos os papéis, junto com as
-- funções de trigger — e no Postgres o EXECUTE de uma função chamada dentro de
-- uma view é checado contra QUEM CONSULTA, não contra o dono da view.
--
-- Resultado: "permission denied for function parse_lesson_date" a cada 5 min
-- e nenhum LESSON_REMINDER enfileirado de 12/09 a 15/09 (antes: 13–22/dia).
--
-- `parse_lesson_date` é um conversor puro de texto para data. A leitura da view
-- continua restrita à service_role (ver 20260912203137); aqui só devolvemos a
-- ela o direito de executar o que a view chama. Precisa rodar DEPOIS de
-- 20260820091231, que refaz o revoke a cada release.
-- ─────────────────────────────────────────────────────────────────────────────

grant execute on function public.parse_lesson_date(text) to service_role;
