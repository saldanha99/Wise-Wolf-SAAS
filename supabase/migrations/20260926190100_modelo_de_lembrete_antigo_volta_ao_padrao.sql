-- ─────────────────────────────────────────────────────────────────────────────
-- Modelo de lembrete "começa em 1 hora" volta ao padrão (26/09/2026)
--
-- A tela "Mensagens" do professor (TeacherMessageSettings) abria com o padrão
-- ANTIGO do front — "nossa aula começa em 1 hora" e {class_link} — e, ao salvar
-- (basta ligar ou desligar o automático), gravava esse texto como se fosse um
-- modelo próprio. Medido em produção: os 3 modelos "personalizados" que existem
-- (Débora, Flávio, Beatrís) são byte a byte esse padrão antigo. O lembrete sai
-- 30 minutos antes; "começa em 1 hora" é informação errada para o aluno.
--
-- Só volta a NULL (padrão do servidor) o modelo IGUAL ao padrão antigo. Quem
-- escreveu o próprio texto não é tocado. One-shot: o release roda migration
-- pendente duas vezes, e sem a trava uma edição futura do professor seria
-- desfeita por engano se alguém reaplicasse o arquivo.
--
-- Efeito colateral conhecido: o {class_link} sai desses três modelos. No
-- automático ele já rendia vazio desde 16/09; no botão "Disparar" (0 usos em 90
-- dias) o link pessoal deixa de ir para os alunos de Flávio e Beatrís. A sala
-- oficial da escola continua indo, numa linha própria (migration 20260926190000).
-- ─────────────────────────────────────────────────────────────────────────────

do $oneshot$
declare
  c_key constant text := 'modelo_de_lembrete_antigo_20260926';
  c_stale_default constant text := E'Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺';
  v_reset integer;
begin
  if exists (select 1 from public.schema_one_shots where key = c_key) then
    return;
  end if;

  update public.profiles
     set lesson_reminder_template = null
   where lesson_reminder_template is not null
     and pg_catalog.btrim(
       pg_catalog.replace(lesson_reminder_template, E'\r', '')
     ) = c_stale_default;
  get diagnostics v_reset = row_count;

  insert into public.schema_one_shots (key, nota)
  values (
    c_key,
    pg_catalog.format(
      'modelos iguais ao padrão antigo do front ("começa em 1 hora") voltaram ao padrão: %s',
      v_reset
    )
  );
  raise notice 'modelos de lembrete antigos zerados: %', v_reset;
end
$oneshot$;
