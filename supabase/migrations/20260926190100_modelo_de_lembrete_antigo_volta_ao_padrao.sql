-- ─────────────────────────────────────────────────────────────────────────────
-- Modelo de lembrete "começa em 1 hora" passa a dizer 30 minutos (26/09/2026)
--
-- A tela "Mensagens" do professor (TeacherMessageSettings) abria com o padrão
-- ANTIGO do front — "nossa aula começa em 1 hora" e {class_link} — e, ao salvar
-- (basta ligar ou desligar o automático), gravava esse texto como se fosse um
-- modelo próprio. Medido em produção: os 3 modelos "personalizados" que existem
-- (Débora, Flávio, Beatrís) são byte a byte esse padrão antigo. O lembrete sai
-- 30 minutos antes (automático) ou entre 15 e 45 minutos antes (botão
-- "Disparar"); "começa em 1 hora" é informação errada para o aluno.
--
-- Só o modelo IGUAL ao padrão antigo é tocado, e só a frase do horário muda: o
-- {class_link} fica onde estava. Ele não é resíduo — Flávio e Beatrís estão com
-- o automático desligado, e no botão "Disparar" o {class_link} leva o link de
-- sempre do aluno quando a aula não tem sala da escola. Voltar esses modelos a
-- NULL (padrão do servidor, sem marcador) tiraria o link da mensagem deles. No
-- automático (Débora) o marcador rende vazio sem sala e a sala da escola quando
-- há — no meio do texto, então a cerca do envio confere igual.
--
-- Quem escreveu o próprio texto não é tocado. One-shot: o release roda migration
-- pendente duas vezes, e sem a trava uma edição futura do professor seria
-- desfeita por engano se alguém reaplicasse o arquivo.
-- ─────────────────────────────────────────────────────────────────────────────

do $oneshot$
declare
  c_key constant text := 'modelo_de_lembrete_antigo_20260926';
  c_stale_default constant text := E'Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺';
  c_fixed constant text := E'Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 30 minutos, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺';
  v_fixed integer;
begin
  if exists (select 1 from public.schema_one_shots where key = c_key) then
    return;
  end if;

  update public.profiles
     set lesson_reminder_template = c_fixed
   where lesson_reminder_template is not null
     and pg_catalog.btrim(
       pg_catalog.replace(lesson_reminder_template, E'\r', ''),
       E' \t\n'
     ) = c_stale_default;
  get diagnostics v_fixed = row_count;

  insert into public.schema_one_shots (key, nota)
  values (
    c_key,
    pg_catalog.format(
      'modelos iguais ao padrão antigo do front ("começa em 1 hora") passaram a dizer 30 minutos, com o {class_link} mantido: %s',
      v_fixed
    )
  );
  raise notice 'modelos de lembrete antigos corrigidos: %', v_fixed;
end
$oneshot$;
