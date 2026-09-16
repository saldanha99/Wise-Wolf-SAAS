-- ─────────────────────────────────────────────────────────────────────────────
-- Lembrete de aula: nada de marcador cru, formatação preservada, e sem link
-- (16/09/2026)
--
-- Um aluno recebeu literalmente:
--   "Oi {student name}, tudo bem? 👋 Lembrando que nossa aula começa em 1 hora,
--    às {class time} . {class link} Te espero! 🐺"
--
-- A raiz não era o modelo da professora, era a "limpeza": o renderizador passava
-- o MODELO por `private.safe_notification_text`, que troca `[[:cntrl:]<>*_\`~]`
-- por espaço e comprime espaços. Ou seja, ela transformava `{student_name}` em
-- `{student name}`, comia o negrito e juntava as quebras de linha — e aí a troca
-- por `\{(\w+)\}` não casava mais com nada. Só quebrava para quem tem modelo
-- próprio: quem usa o padrão nunca passava por essa limpeza.
--
-- Essa função existe para limpar VALOR (nome do aluno, nome da professora), onde
-- tirar `*` e `_` faz sentido. Modelo é outra coisa: ali `_` e `*` são conteúdo.
--
-- Regras que ficam:
--   • modelo é limpo por `private.safe_notification_template`, que tira caractere
--     de controle e `<>\`` mas preserva quebra de linha, negrito e underline;
--   • marcador é reconhecido com espaço, hífen ou maiúscula ({student name},
--     {Student-Name}, { student_name });
--   • marcador DESCONHECIDO vira nada — frase sem um pedaço é ruim, mas frase com
--     "{class time}" no meio diz ao aluno que ninguém lê o que a escola manda;
--   • o link da sala sai do lembrete, por decisão da direção: quem combina a sala
--     com o aluno é o professor. `{class_link}` continua aceito e rende vazio.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.safe_notification_template(p_value text)
returns text language sql immutable set search_path = '' as $fn$
  select pg_catalog.left(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          -- fora caractere de controle, mantendo quebra de linha e tabulação
          pg_catalog.regexp_replace(coalesce(p_value, ''), '[^[:print:][:space:]]', '', 'g'),
          '[<>`]', '', 'g'
        ),
        E'\r\n?', E'\n', 'g'
      )
    ),
    4096
  );
$fn$;

create or replace function private.render_lesson_notification_message(
  p_template text,
  p_student_name text,
  p_class_time text,
  p_teacher_name text,
  p_tenant_name text,
  p_class_link text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_template text := private.safe_notification_template(p_template);
  v_message text;
  -- Barra invertida no valor viraria referência de grupo no regexp_replace.
  v_student text := pg_catalog.replace(
    private.safe_notification_text(p_student_name, 160), '\', '\\');
  v_time text := pg_catalog.replace(
    private.safe_notification_text(p_class_time, 40), '\', '\\');
  v_teacher text := pg_catalog.replace(
    private.safe_notification_text(p_teacher_name, 160), '\', '\\');
  v_tenant text := pg_catalog.replace(
    private.safe_notification_text(p_tenant_name, 160), '\', '\\');
begin
  if v_template = '' then
    v_template := $default_template$Oi {student_name}, tudo bem? 👋

Lembrando que nossa aula começa em 30 minutos, às *{class_time}*.

Te espero! 🐺$default_template$;
  end if;

  v_message := pg_catalog.regexp_replace(
    v_template, '\{\s*student[ _-]*name\s*\}', v_student, 'gi');
  v_message := pg_catalog.regexp_replace(
    v_message, '\{\s*class[ _-]*time\s*\}', v_time, 'gi');
  v_message := pg_catalog.regexp_replace(
    v_message, '\{\s*teacher[ _-]*name\s*\}', v_teacher, 'gi');
  v_message := pg_catalog.regexp_replace(
    v_message, '\{\s*tenant[ _-]*name\s*\}', v_tenant, 'gi');
  -- O link é aceito e descartado: o parâmetro segue na assinatura para não
  -- quebrar quem chama, mas não vai mais para o aluno.
  v_message := pg_catalog.regexp_replace(
    v_message, '\{\s*class[ _-]*link\s*\}', '', 'gi');
  -- Qualquer outro marcador (inclusive escrito com espaço) é apagado.
  v_message := pg_catalog.regexp_replace(v_message, '\{[^{}]{0,60}\}', '', 'g');
  -- Espaço sobrando no fim da linha e linha que ficou vazia não viram buraco.
  v_message := pg_catalog.regexp_replace(v_message, '[ \t]+(\n|$)', '\1', 'g');
  v_message := pg_catalog.regexp_replace(v_message, '\n{3,}', E'\n\n', 'g');
  return pg_catalog.left(pg_catalog.btrim(v_message), 4096);
end;
$function$;

alter function private.safe_notification_template(text) owner to postgres;
alter function private.render_lesson_notification_message(
  text, text, text, text, text, text
) owner to postgres;
