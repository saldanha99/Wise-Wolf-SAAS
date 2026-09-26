-- Termo de registro das aulas v3, aceite que vale só na versão vigente e
-- retenção da memória das aulas do lado do banco (onda 2, 27/09/2026).
--
-- ⚠️ Depende da onda 1 (20260926170000 a 20260926220000, no ar desde
-- 26/09/2026): parte das definições vivas de 20260926200000 (aceite efetivo do
-- aluno, decisão e campos da página pública), 20260926180000 (aceite do
-- professor, aceite que caiu, job que aplica o termo) e 20260926220000 (cartão
-- do aluno).
-- ⚠️ O texto v3 promete apagar os ORIGINAIS no Drive da escola 90 dias depois
-- da aula (decisão da direção). Nada aqui faz isso: é a frente
-- wave2/retencao-drive, com escopo de escrita no Drive (a conta central tem só
-- drive.readonly). O primeiro original vence 90 dias depois da primeira aula
-- transcrita sob a v3 — a remoção precisa estar no ar até lá.
--
-- 1. Texto v3 (aluno e professor). Diz com exatidão o que o sistema faz depois
--    das ondas 1–3: transcrição e anotações do Google (sem vídeo); resumo
--    automático por IA que só entra na ficha depois da aprovação do professor;
--    planejamento da próxima aula e da tarefa com IA; dossiê por link com login
--    na troca de professor ou para o substituto; cartão do aluno com sugestões
--    da IA revisadas pelo professor, NUNCA saúde, religião, política, família ou
--    dinheiro, e para menor só interesses pedagógicos; confirmação de que a aula
--    aconteceu; no termo do professor, o extrato de pontualidade sem nota nem
--    ranking, que não mexe no pagamento. Quem vê (inclusive o suporte técnico
--    do fornecedor do sistema, que lê resumo aprovado e cartão), quem processa
--    (o fornecedor do sistema, Google Workspace e o provedor de IA contratado
--    pela escola), prazos, direitos e o controlador.
--    O controlador é a ESCOLA, por marcadores ({escola_nome},
--    {escola_documento}, {escola_contato_privacidade}) que o SERVIDOR preenche
--    com os dados da própria escola (private.lesson_recording_fill_term) antes
--    de devolver o texto a qualquer tela: dado da Wise Wolf (razão social,
--    CNPJ, e-mail) nunca entra no código, e tela nenhuma — nem PWA antigo em
--    cache — mostra o marcador cru. Texto é versão nova, nunca update.
-- 2. Aceite por versão: aceite de versão anterior à vigente NÃO marca aula
--    (aluno e professor). O job desmarca o que ele tinha marcado — a régua do
--    "aceite que caiu" de 20260926180000 (lesson_session_term_consent_lapsed)
--    passa a olhar a versão que valia no FIM PREVISTO da aula: aula que
--    terminou antes da versão nova continua importável sob o aceite que valia
--    nela; a futura e a que estava em andamento na publicação caem — e o
--    evento diz o motivo certo ("o termo mudou de versão"), não "a escola
--    exige o responsável". O aceite grava a versão que a pessoa LEU: a página
--    e o cartão mandam a versão exibida e o servidor recusa ("termo_mudou")
--    se ela não for a vigente. Página pública, cartão do professor e painel da
--    escola mostram "o termo mudou" e deixam aceitar de novo. O envio em lote
--    (20260926210000) já trata aceite de versão anterior como pendente
--    ("term_updated"); quem recusou ou revogou continua sem pedido novo
--    (decisão da direção na onda 1).
-- 3. Retenção do lado do banco, função e cron PRÓPRIOS (não mexe em
--    public.purge_expired_meet_artifacts, que é de outra frente):
--    (a) toda versão de resumo — rascunho E aprovada — perde os trechos
--        copiados da aula (narrative: as anotações do Google ou o texto por
--        cima delas; evidence: citações literais da transcrição) 90 dias
--        depois da aula;
--    (b) quem DEIXOU a escola (lifecycle_status = 'offboarded' com o
--        desligamento concluído) perde, 90 dias depois do fim, a memória de
--        origem MEET_SESSION, o cartão do aluno e o conteúdo dos resumos das
--        aulas dele;
--    (c) cada rodada deixa uma trilha só com contagens, por escola.
--
-- Em 26/09/2026 havia 0 aceites, 0 salas, 0 resumos e 0 memórias MEET_SESSION
-- em produção: nada existente muda de estado com esta migration.

-- ---------------------------------------------------------------------------
-- 1. Texto v3
-- ---------------------------------------------------------------------------

insert into private.lesson_recording_terms (audience, version, body) values
(
  'STUDENT', 'v3',
  $term$As aulas acontecem numa sala do Google Meet criada pela escola. Nessas salas, o Google transcreve a aula (transforma em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo. O Google também informa a que horas cada pessoa entrou e saiu da sala.

Para que usamos
• Dar continuidade às aulas: saber o que foi trabalhado em cada uma.
• Resumo da aula: depois de cada aula, um resumo é preparado automaticamente com ajuda de inteligência artificial (IA). Ele só entra na ficha do aluno depois que o professor lê, corrige se precisar e aprova.
• Planejar a próxima aula e a tarefa de casa, com ajuda de IA, a partir do resumo aprovado.
• Troca de professor: se o aluno passar para outro professor ou tiver aula com um substituto, esse professor recebe o histórico pedagógico (o dossiê) por um link que só abre com login na plataforma da escola.
• Cartão do aluno: o professor anota o objetivo do aluno, os temas que o engajam e como ele prefere ser corrigido. A IA pode sugerir itens, mas só entra o que o professor revisar. Nunca guardamos informação sobre saúde, religião, política, família ou dinheiro. Para menores de 18 anos, o cartão guarda só interesses pedagógicos (objetivo e temas).
• Confirmar que a aula aconteceu, pelos horários de entrada e saída da sala.

Quem vê
• A transcrição completa: só o professor daquela aula, a coordenação e a direção da escola.
• O resumo aprovado e o cartão do aluno: os professores do aluno, a coordenação e a direção. Até 90 dias depois da aula, o resumo aprovado pode trazer trechos das anotações e da transcrição que o professor manteve na revisão.
• O suporte técnico do fornecedor do sistema pode ver o resumo aprovado e o cartão do aluno, só para resolver problema técnico. A transcrição completa, não.
• O aluno (ou o responsável) vê no aplicativo os resumos aprovados das suas aulas.

Quem processa os dados, além da escola
• Fornecedor do sistema que a escola usa (esta plataforma): guarda os dados no servidor dele e dá suporte técnico.
• Google (Google Workspace), fornecedor da escola: sala, transcrição, anotações e relatório de presença.
• Provedor de IA contratado pela escola (OpenRouter), serviço pago, com o uso dos dados para treinar modelos desligado. Ele prepara o resumo e as sugestões de planejamento e de cartão.

Por quanto tempo
• No sistema da escola: a transcrição, as anotações e o relatório de presença ficam 90 dias, contados de quando chegam ao sistema (logo depois da aula). Os trechos da aula copiados para o resumo (o texto das anotações e as citações da transcrição) são apagados 90 dias depois da aula, no rascunho e no resumo aprovado.
• Na conta Google da escola: os arquivos originais (transcrição, anotações e relatório de presença) são apagados 90 dias depois da aula. Eles vão para a lixeira do Google, que os elimina de vez em até 30 dias.
• O resumo aprovado (objetivo, conteúdos, dificuldades, tarefa e próximo passo) e o cartão do aluno ficam enquanto o aluno estudar na escola e são apagados 90 dias depois que ele deixar a escola.

Quando este termo mudar
• A escola pede a resposta de novo. Até lá, as próximas aulas não são transcritas; o que já foi registrado segue os prazos acima.

Seus direitos
• Ver o seu registro: os resumos aprovados das suas aulas ficam no aplicativo da escola.
• Revogar a autorização a qualquer momento, pelo mesmo link ou pelo WhatsApp da escola. A partir daí as aulas seguintes deixam de ser transcritas.
• Pedir a exclusão do que já foi registrado, pelo WhatsApp da escola.
• Pedir informação, correção ou cópia dos seus dados pelo contato de privacidade abaixo.

Quem é responsável pelos dados
• A escola: {escola_nome}, {escola_documento}. Contato para assuntos de privacidade: {escola_contato_privacidade}.

Menores de 18 anos
• Quem autoriza é o responsável legal.

Sem autorização, a aula acontece normalmente, só que sem transcrição.$term$
),
(
  'TEACHER', 'v3',
  $term$As aulas da escola acontecem em salas do Google Meet criadas pela conta da escola, com você como coanfitrião, pela conta Google que você confirmou. Nessas salas, o Google transcreve a aula (transforma em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo.

Para que usamos
• Continuidade pedagógica do aluno.
• Resumo da aula: depois de cada aula, um resumo é preparado automaticamente com ajuda de inteligência artificial (IA). Ele só entra na ficha do aluno depois que você lê, corrige se precisar e aprova.
• Planejar a próxima aula e a tarefa de casa, com ajuda de IA, a partir do resumo aprovado.
• Troca de professor: se o aluno passar para outro professor ou tiver aula com um substituto, esse professor recebe o dossiê pedagógico por um link que só abre com login na plataforma da escola.
• Cartão do aluno: você anota o objetivo, os temas que engajam e como o aluno prefere ser corrigido. A IA pode sugerir itens, mas só entra o que você revisar. Nunca registre saúde, religião, política, família ou dinheiro. Para menores de 18 anos, só interesses pedagógicos (objetivo e temas).
• Confirmar que a aula aconteceu: o Google informa a que horas cada participante entrou e saiu da sala.

Extrato de pontualidade
• Quando a escola ligar este recurso, você verá um extrato com o horário em que entrou na sala em cada aula. É para você acompanhar: sem nota, sem ranking e sem comparação com outros professores.
• O extrato não altera o seu pagamento.

Como usamos as divergências
• Uma divergência (por exemplo, aula lançada sem ninguém na sala) vira um aviso para a coordenação conversar com você.
• Nada disso muda o seu pagamento automaticamente. Qualquer ajuste passa pela direção, como hoje.

Quem vê
• A transcrição completa das suas aulas: você, a coordenação e a direção da escola.
• Outros professores do aluno veem só o resumo aprovado. Até 90 dias depois da aula, ele pode trazer trechos das anotações e da transcrição que você manteve na revisão.
• O suporte técnico do fornecedor do sistema pode ver o resumo aprovado e o cartão do aluno, só para resolver problema técnico. A transcrição completa, não.

Quem processa os dados, além da escola
• Fornecedor do sistema que a escola usa (esta plataforma): guarda os dados no servidor dele e dá suporte técnico.
• Google (Google Workspace), fornecedor da escola: sala, transcrição, anotações e relatório de presença.
• Provedor de IA contratado pela escola (OpenRouter), serviço pago, com o uso dos dados para treinar modelos desligado.

Por quanto tempo
• No sistema da escola: transcrição, anotações e relatório de presença ficam 90 dias, contados de quando chegam ao sistema (logo depois da aula). Os trechos da aula copiados para o resumo (o texto das anotações e as citações da transcrição) são apagados 90 dias depois da aula, no rascunho e no resumo aprovado.
• Na conta Google da escola: os arquivos originais são apagados 90 dias depois da aula. Eles vão para a lixeira do Google, que os elimina de vez em até 30 dias.
• O resumo aprovado (objetivo, conteúdos, dificuldades, tarefa e próximo passo) e o cartão do aluno ficam enquanto o aluno estudar na escola e são apagados 90 dias depois que ele deixar a escola.

Quando este termo mudar
• A escola pede a sua resposta de novo. Até lá, as suas próximas aulas não são transcritas; o que já foi registrado segue os prazos acima.

Seus direitos
• Ver o registro das suas aulas no aplicativo.
• Revogar quando quiser, nesta mesma tela. A partir daí, as suas aulas deixam de ser transcritas.
• Pedir a exclusão do que já foi registrado, pelo WhatsApp da escola.

Quem é responsável pelos dados
• A escola: {escola_nome}, {escola_documento}. Contato para assuntos de privacidade: {escola_contato_privacidade}.$term$
)
on conflict (audience, version) do nothing;

-- O texto publicado precisa carregar os três marcadores; a página não inventa
-- o controlador, só preenche o que o texto pede.
do $markers$
begin
  if exists (
    select 1 from private.lesson_recording_terms as term
    where term.version = 'v3'
      and not (term.body like '%{escola_nome}%'
        and term.body like '%{escola_documento}%'
        and term.body like '%{escola_contato_privacidade}%')
  ) then
    raise exception 'termo_v3_sem_marcadores_da_escola';
  end if;
end
$markers$;

-- ---------------------------------------------------------------------------
-- 2. Quem é a escola no termo (controlador), a partir dos dados dela
-- ---------------------------------------------------------------------------

-- Texto curto para o termo: sem quebra de linha nem caractere de controle, e
-- sem chaves — o valor nunca vira (nem parece) um marcador do texto.
create or replace function private.lesson_recording_clean_label(p_value text, p_max integer)
returns text
language sql immutable set search_path = '' as $$
  select nullif(left(pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(coalesce(p_value, ''), '{}', ''), '[[:cntrl:][:space:]]+', ' ', 'g')), p_max), '');
$$;

-- Os valores dos marcadores {escola_nome}, {escola_documento} e
-- {escola_contato_privacidade}, lidos de tenants.school_info (a tela
-- Configurações → Escola e legal). Faltou um dado: texto neutro que não inventa
-- nada, e `missing` diz ao painel da direção o que completar.
create or replace function private.lesson_recording_school_identity(p_tenant text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_info jsonb;
  v_tenant_name text;
  v_legal_name text;
  v_name text;
  v_cnpj text;
  v_digits text;
  v_email text;
  v_officer text;
  v_missing text[] := '{}'::text[];
begin
  select case when pg_catalog.jsonb_typeof(tenant.school_info) = 'object' then tenant.school_info end,
         private.lesson_recording_clean_label(tenant.name, 160)
    into v_info, v_tenant_name
  from public.tenants as tenant
  where tenant.id = p_tenant;
  v_info := coalesce(v_info, '{}'::jsonb);

  v_legal_name := private.lesson_recording_clean_label(v_info ->> 'legalName', 160);
  v_name := coalesce(v_legal_name, private.lesson_recording_clean_label(v_info ->> 'name', 160), v_tenant_name);
  v_digits := pg_catalog.regexp_replace(coalesce(v_info ->> 'cnpj', ''), '\D', '', 'g');
  v_cnpj := case
    when length(v_digits) = 14 then
      substr(v_digits, 1, 2) || '.' || substr(v_digits, 3, 3) || '.' || substr(v_digits, 6, 3)
        || '/' || substr(v_digits, 9, 4) || '-' || substr(v_digits, 13, 2)
    else private.lesson_recording_clean_label(v_info ->> 'cnpj', 40)
  end;
  v_email := private.lesson_recording_clean_label(v_info ->> 'privacyContactEmail', 160);
  v_officer := private.lesson_recording_clean_label(v_info ->> 'privacyOfficerName', 160);

  if v_legal_name is null then v_missing := v_missing || 'razao_social'::text; end if;
  if v_cnpj is null then v_missing := v_missing || 'cnpj'::text; end if;
  if v_email is null then v_missing := v_missing || 'contato_privacidade'::text; end if;

  return jsonb_build_object(
    'escola_nome', coalesce(v_name, 'a escola'),
    'escola_documento', case when v_cnpj is not null then 'CNPJ ' || v_cnpj
      else 'CNPJ não informado pela escola' end,
    'escola_contato_privacidade', case
      when v_officer is not null and v_email is not null then v_officer || ' — ' || v_email
      when v_email is not null then v_email
      when v_officer is not null then v_officer || ', pelo WhatsApp da escola'
      else 'a direção da escola, pelo WhatsApp da escola'
    end,
    'missing', pg_catalog.to_jsonb(v_missing)
  );
end;
$$;

-- O texto do termo como a pessoa lê: marcadores trocados pelos dados da
-- escola. TODA rota que devolve o texto a uma tela passa por aqui — a página
-- pública, o cartão do professor e qualquer outra (a tela do aluno com o
-- próprio registro, por exemplo). Preencher só no navegador deixava o marcador
-- cru em tela que não sabia preenchê-lo e em PWA antigo em cache.
-- Os valores não têm chaves (lesson_recording_clean_label), então trocar um
-- marcador nunca cria outro.
create or replace function private.lesson_recording_fill_term(p_body text, p_tenant text)
returns text
language sql stable security definer set search_path = '' as $$
  select case when p_body is null then null else
    pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_body,
      '{escola_nome}', school.identity ->> 'escola_nome'),
      '{escola_documento}', school.identity ->> 'escola_documento'),
      '{escola_contato_privacidade}', school.identity ->> 'escola_contato_privacidade')
  end
  from (select private.lesson_recording_school_identity(p_tenant) as identity) as school;
$$;

-- ---------------------------------------------------------------------------
-- 3. Aceite que vale = aceite da versão VIGENTE
-- ---------------------------------------------------------------------------

create or replace function private.lesson_recording_current_version(p_audience text)
returns text
language sql stable security definer set search_path = '' as $$
  select (private.lesson_recording_current_term(p_audience)).version;
$$;

-- Versão do termo da última decisão da pessoa (revogação pela escola: nula).
create or replace function private.lesson_recording_decided_term_version(p_subject uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select consent.term_version
  from private.lesson_recording_consents as consent
  where consent.subject_id = p_subject
  order by consent.seq desc
  limit 1;
$$;

-- A última decisão é "autorizo", mas de uma versão que não é mais a vigente.
create or replace function private.lesson_recording_accepted_outdated_term(p_subject uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and last_decision.term_version is distinct from
        private.lesson_recording_current_version(last_decision.term_audience)
    from (
      select consent.decision, consent.term_audience, consent.term_version
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_subject
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$$;

-- O aceite da versão p_version cobre o instante p_at? A versão exigida é a que
-- valia em p_at — a última publicada até ele; de agora em diante, a vigente
-- (mesma ordem de lesson_recording_current_term). Cobre quem aceitou essa
-- versão ou uma mais nova. É o que separa a aula que TERMINOU sob o aceite (a
-- versão nova não a derruba: a importação dela segue o que valia na aula) da
-- aula futura ou em andamento na publicação (cai até a pessoa aceitar a nova).
create or replace function private.lesson_recording_term_covers(
  p_audience text, p_version text, p_at timestamptz
) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (accepted.published_at, accepted.version) >= (required.published_at, required.version)
    from private.lesson_recording_terms as accepted
    cross join lateral (
      select term.published_at, term.version
      from private.lesson_recording_terms as term
      where term.audience = p_audience
        and (term.published_at <= p_at or p_at >= pg_catalog.now())
      order by term.published_at desc, term.version desc
      limit 1
    ) as required
    where accepted.audience = p_audience
      and accepted.version = p_version
  ), false);
$$;

-- Aluno: partindo da definição viva (20260926200000). Última decisão é aceite
-- com código, de uma versão que cobre p_at, e, se HOJE o cadastro exige
-- responsável, dado pelo responsável (a régua do responsável continua valendo
-- na hora, como na onda 1). Sem termo publicado, nada vale (fail-closed).
create or replace function private.lesson_recording_student_consent_effective_at(p_student uuid, p_at timestamptz)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and last_decision.verification = 'WHATSAPP_CODE'
      and private.lesson_recording_term_covers('STUDENT', last_decision.term_version, p_at)
      and (last_decision.signer_relation = 'GUARDIAN'
        or not private.lesson_recording_requires_guardian(p_student))
    from (
      select consent.decision, consent.verification, consent.signer_relation, consent.term_version
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_student
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$$;

-- Agora: o aceite tem de ser da versão VIGENTE.
create or replace function private.lesson_recording_student_consent_effective(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_student_consent_effective_at(p_student, pg_catalog.now());
$$;

-- Professor: última decisão é aceite de uma versão que cobre p_at. Antes
-- bastava a última decisão ser "autorizo" — de qualquer versão.
create or replace function private.lesson_recording_teacher_consent_effective_at(p_teacher uuid, p_at timestamptz)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and private.lesson_recording_term_covers('TEACHER', last_decision.term_version, p_at)
    from (
      select consent.decision, consent.term_version
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_teacher
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$$;

create or replace function private.lesson_recording_teacher_consent_effective(p_teacher uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_teacher_consent_effective_at(p_teacher, pg_catalog.now());
$$;

-- Os dois aceites valem para uma aula que termina (ou terminou) em p_at.
create or replace function private.lesson_recording_active_at(p_student uuid, p_teacher uuid, p_at timestamptz)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_student_consent_effective_at(p_student, p_at)
    and private.lesson_recording_teacher_consent_effective_at(p_teacher, p_at);
$$;

-- Partindo da definição viva (20260926200000): o professor passa a exigir a
-- versão vigente como o aluno. É por aqui que o job marca (próximas 24 h).
create or replace function private.lesson_recording_active(p_student uuid, p_teacher uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_active_at(p_student, p_teacher, pg_catalog.now());
$$;

-- Aceite do termo que caiu SEM decisão nova. Partindo da definição viva
-- (20260926180000): o mesmo desenho — sessão marcada PELO TERMO, último "sim"
-- dos dois, e o aceite não vale —, mas o "não vale" é avaliado no FIM PREVISTO
-- da aula. Antes (e na primeira versão desta migration) era avaliado agora:
-- publicar uma versão nova do termo às 18:40 cegava a importação da aula que
-- terminou às 18:30 sob aceite válido (transcrição, presença, fila de 7 dias),
-- quando nem a revogação explícita barra aula que já tinha terminado. A régua
-- do responsável continua na hora (aceite "como aluno" de quem virou menor).
create or replace function private.lesson_session_term_consent_lapsed(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce((
        select event.allowed and event.reason like 'Termo de registro das aulas%'
        from private.lesson_documentation_consent_events as event
        where event.session_id = session.id
        order by event.created_at desc
        limit 1
      ), false)
      and private.lesson_recording_consent_state(session.student_id) = 'ACCEPTED'
      and private.lesson_recording_consent_state(session.teacher_id) = 'ACCEPTED'
      and not private.lesson_recording_active_at(session.student_id, session.teacher_id, session.scheduled_end_at)
    from public.lesson_sessions as session
    where session.id = p_session
  ), false);
$$;

-- Por que o aceite do termo caiu numa sessão marcada por ele (texto do evento
-- que o job grava ao desmarcar). Versão desatualizada vem primeiro: quem
-- aceitou a v2 precisa ler a v3 de qualquer jeito.
create or replace function private.lesson_session_term_lapse_text(p_session uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when private.lesson_recording_accepted_outdated_term(session.student_id)
        and private.lesson_recording_accepted_outdated_term(session.teacher_id)
        then 'o termo mudou de versão e o aluno (ou o responsável) e o professor ainda não aceitaram a versão vigente.'
      when private.lesson_recording_accepted_outdated_term(session.student_id)
        then 'o termo mudou de versão e o aluno (ou o responsável) ainda não aceitou a versão vigente.'
      when private.lesson_recording_accepted_outdated_term(session.teacher_id)
        then 'o termo mudou de versão e o professor ainda não aceitou a versão vigente.'
      else 'o aceite do aluno deixou de valer (hoje a escola exige o responsável).'
    end
    from public.lesson_sessions as session
    where session.id = p_session
  ), 'o aceite do termo deixou de valer.');
$$;

-- ---------------------------------------------------------------------------
-- 4. Página pública: "o termo mudou" e quem é a escola
-- ---------------------------------------------------------------------------

-- Partindo da definição viva (20260926200000). Toda versão de
-- get_lesson_recording_consent_public junta estes campos no fim (a do envio em
-- lote foi remendada por âncora e mantém o `||`), então a página ganha os
-- campos novos sem recriar a função pública.
create or replace function private.lesson_recording_public_link_fields(p_link_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_link private.lesson_recording_consent_links;
  v_reason text;
  v_decision text;
  v_verification text;
  v_decided_version text;
  v_effective boolean;
  v_outdated boolean;
begin
  select * into v_link from private.lesson_recording_consent_links where id = p_link_id;
  if not found then
    return '{}'::jsonb;
  end if;
  v_reason := private.lesson_recording_guardian_reason(v_link.student_id);
  select consent.decision, consent.verification, consent.term_version
    into v_decision, v_verification, v_decided_version
  from private.lesson_recording_consents as consent
  where consent.subject_id = v_link.student_id
  order by consent.seq desc
  limit 1;
  v_effective := private.lesson_recording_student_consent_effective(v_link.student_id);
  v_outdated := private.lesson_recording_accepted_outdated_term(v_link.student_id);

  return jsonb_build_object(
    'requires_guardian', v_reason is not null,
    'guardian_reason', v_reason,
    'student_phone_masked', private.lesson_recording_mask_phone(v_link.student_phone),
    'guardian_phone_masked', private.lesson_recording_mask_phone(v_link.guardian_phone),
    'current_effective', v_effective,
    'decided_term_version', v_decided_version,
    -- Aceite gravado que não vale: de versão anterior à vigente (o termo
    -- mudou), sem o código (versão anterior do link) ou dado pelo aluno quando
    -- hoje o cadastro exige o responsável.
    'current_not_effective_reason', case
      when v_decision = 'ACCEPTED' and not v_effective then
        case
          when v_outdated then 'TERM_UPDATED'
          when v_verification is distinct from 'WHATSAPP_CODE' then 'UNVERIFIED'
          else 'GUARDIAN_REQUIRED'
        end
    end,
    -- Valores dos marcadores do controlador no texto do termo.
    'school_identity', private.lesson_recording_school_identity(v_link.tenant_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Cartão do professor: "o termo mudou", quem é a escola e o aceite da
--    versão lida
-- ---------------------------------------------------------------------------

-- Partindo da definição viva (20260926120000; nenhuma migration posterior a
-- recriou). Acrescenta a versão que o professor aceitou, se o aceite vale e os
-- valores dos marcadores da escola.
create or replace function public.get_my_lesson_recording_consent()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_last private.lesson_recording_consents;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    return jsonb_build_object('applies', false);
  end if;
  v_term := private.lesson_recording_current_term('TEACHER');
  select * into v_last from private.lesson_recording_consents
   where subject_id = v_me.id order by seq desc limit 1;
  return jsonb_build_object(
    'applies', true,
    'decision', coalesce(v_last.decision, 'NONE'),
    'decided_at', v_last.decided_at,
    'decided_term_version', v_last.term_version,
    'effective', private.lesson_recording_teacher_consent_effective(v_me.id),
    'term_updated', private.lesson_recording_accepted_outdated_term(v_me.id),
    'term_version', v_term.version,
    -- Já preenchido: cartão em cache (PWA antigo) não mostra marcador cru.
    'term_body', private.lesson_recording_fill_term(v_term.body, v_me.tenant_id),
    'school_identity', private.lesson_recording_school_identity(v_me.tenant_id)
  );
end;
$$;

-- Aceite do professor grava a versão que ele LEU. Partindo da definição viva
-- (20260926180000): o cartão manda a versão que mostrou; se ela não é a
-- vigente (a direção publicou outra enquanto o texto estava aberto, ou o
-- cartão é de um PWA antigo que não manda versão), o aceite é recusado com
-- `termo_mudou` e nada é gravado — antes ficava gravado o aceite da versão
-- vigente no clique, que a pessoa nunca viu. Recusar e revogar valem sempre
-- (um "não" nunca espera), gravando a versão lida quando o cartão informa uma
-- que existe. A assinatura antiga sai: com o parâmetro opcional ao lado, o
-- PostgREST teria duas candidatas.
drop function if exists public.set_my_lesson_recording_consent(boolean);
create or replace function public.set_my_lesson_recording_consent(p_accept boolean, p_term_version text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_version text;
  v_decision text;
begin
  if p_accept is null then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if length(btrim(coalesce(v_me.full_name, ''))) < 3 then
    raise exception 'complete_seu_nome_no_perfil' using errcode = '22023';
  end if;
  if p_accept and not exists (
    select 1 from private.teacher_google_identities as ident
    where ident.teacher_id = v_me.id and ident.tenant_id = v_me.tenant_id and ident.email_verified
  ) then
    raise exception 'teacher_google_identity_required' using errcode = '22023';
  end if;

  v_term := private.lesson_recording_current_term('TEACHER');
  if p_accept and (v_term.version is null or p_term_version is distinct from v_term.version) then
    raise exception 'termo_mudou' using errcode = '22023',
      detail = 'versao_vigente=' || coalesce(v_term.version, '');
  end if;
  v_version := case when p_accept then v_term.version else coalesce((
    select term.version from private.lesson_recording_terms as term
    where term.audience = 'TEACHER' and term.version = p_term_version
  ), v_term.version) end;
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, recorded_by
  ) values (
    v_me.tenant_id, v_me.id, 'TEACHER', v_decision, left(btrim(v_me.full_name), 120), 'SELF',
    'TEACHER', v_version, 'APP', v_me.id
  );
  return jsonb_build_object('ok', true, 'decision', v_decision, 'term_version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Página pública: a decisão grava a versão lida
-- ---------------------------------------------------------------------------

-- Decisão pela página pública grava a versão que a pessoa LEU. Partindo da
-- definição viva (20260926200000; nenhuma migration posterior a recriou). A
-- página manda a versão exibida; aceite de versão que não é a vigente volta
-- `termo_mudou` ANTES de conferir o código — o código não é gasto nem conta
-- tentativa, e a página recarrega o texto novo para a pessoa ler e confirmar
-- com o mesmo código. Sem versão (página de um PWA antigo), o aceite também é
-- recusado. Recusar vale sempre. A assinatura de cinco argumentos sai pelo
-- mesmo motivo da do professor.
drop function if exists public.decide_lesson_recording_consent_public(text, text, text, boolean, text);
create or replace function public.decide_lesson_recording_consent_public(
  p_token text,
  p_signer_name text,
  p_relation text,
  p_accept boolean,
  p_code text,
  p_term_version text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limits jsonb := private.lesson_recording_code_limits();
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_version text;
  v_challenge private.lesson_recording_consent_challenges;
  v_name text := btrim(regexp_replace(coalesce(p_signer_name, ''), '\s+', ' ', 'g'));
  v_code text := btrim(coalesce(p_code, ''));
  v_decision text;
  v_masked text;
  v_wrong_total integer;
begin
  if p_accept is null or coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  if coalesce(p_relation, '') not in ('SELF', 'GUARDIAN') then
    raise exception 'relacao_invalida' using errcode = '22023';
  end if;
  if length(v_name) < 5 or length(v_name) > 120 or v_name !~ '^\S+( \S+)+$' then
    raise exception 'nome_completo_obrigatorio' using errcode = '22023';
  end if;

  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if found and v_link.blocked_at is not null then
    raise exception 'link_bloqueado' using errcode = '22023';
  end if;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    raise exception 'link_expirado' using errcode = '22023';
  end if;
  if p_relation = 'SELF' and private.lesson_recording_requires_guardian(v_link.student_id) then
    raise exception 'responsavel_obrigatorio' using errcode = '22023';
  end if;

  -- O aceite é do texto que a pessoa leu: versão diferente da vigente (ou não
  -- informada) volta antes do código, sem gastá-lo.
  v_term := private.lesson_recording_current_term('STUDENT');
  if p_accept and (v_term.version is null or p_term_version is distinct from v_term.version) then
    return jsonb_build_object('ok', false, 'error', 'termo_mudou', 'term_version', v_term.version);
  end if;

  -- Daqui em diante os erros do código voltam como resposta, não exceção:
  -- a tentativa errada precisa ficar gravada.
  if v_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;

  select * into v_challenge
  from private.lesson_recording_consent_challenges as challenge
  where challenge.link_id = v_link.id
    and challenge.relation = p_relation
    and challenge.consumed_at is null
    and challenge.invalidated_at is null
    and challenge.delivery_status in ('SENT', 'AMBIGUOUS')
  order by challenge.seq desc
  limit 1
  for update;
  if not found or v_challenge.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error', 'codigo_expirado');
  end if;
  if v_challenge.attempts >= (v_limits ->> 'wrong_attempts_per_code')::integer then
    return jsonb_build_object('ok', false, 'error', 'codigo_bloqueado', 'attempts_left', 0);
  end if;

  if encode(extensions.digest(v_challenge.id::text || ':' || v_code, 'sha256'), 'hex') <> v_challenge.code_hash then
    update private.lesson_recording_consent_challenges
       set attempts = attempts + 1,
           invalidated_at = case when attempts + 1 >= (v_limits ->> 'wrong_attempts_per_code')::integer
             then pg_catalog.now() else invalidated_at end
     where id = v_challenge.id;
    -- Tentativas erradas somando todos os códigos do link: passou do teto,
    -- quem está chutando não tem o WhatsApp da família; o link fecha.
    select coalesce(sum(challenge.attempts), 0) into v_wrong_total
    from private.lesson_recording_consent_challenges as challenge
    where challenge.link_id = v_link.id;
    if v_wrong_total >= (v_limits ->> 'wrong_attempts_per_link')::integer then
      perform private.lesson_recording_block_link(v_link.id, 'CODE_ATTEMPTS');
      return jsonb_build_object('ok', false, 'error', 'link_bloqueado', 'attempts_left', 0);
    end if;
    return jsonb_build_object(
      'ok', false,
      'error', case when v_challenge.attempts + 1 >= (v_limits ->> 'wrong_attempts_per_code')::integer
        then 'codigo_bloqueado' else 'codigo_incorreto' end,
      'attempts_left', greatest(0, (v_limits ->> 'wrong_attempts_per_code')::integer - (v_challenge.attempts + 1))
    );
  end if;

  update private.lesson_recording_consent_challenges
     set consumed_at = pg_catalog.now()
   where id = v_challenge.id;

  v_version := case when p_accept then v_term.version else coalesce((
    select term.version from private.lesson_recording_terms as term
    where term.audience = 'STUDENT' and term.version = p_term_version
  ), v_term.version) end;
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  v_masked := private.lesson_recording_mask_phone(v_challenge.destination);
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, link_id, signer_ip, signer_user_agent,
    verification, verified_phone, verification_challenge_id
  ) values (
    v_link.tenant_id, v_link.student_id, 'STUDENT', v_decision, v_name, p_relation,
    'STUDENT', v_version, 'LINK', v_link.id,
    private.lesson_recording_request_header('x-forwarded-for', 64),
    private.lesson_recording_request_header('user-agent', 300),
    'WHATSAPP_CODE', v_masked, v_challenge.id
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'verified_phone', v_masked,
    'term_version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Remendos por âncora sobre as definições vivas
-- ---------------------------------------------------------------------------
-- Painel da escola (list_lesson_recording_consents, de 20260926200000) e job do
-- termo (apply_standing_lesson_recording_consent, de 20260926180000) são
-- mexidos por mais de uma frente: recriar a partir de um texto antigo apagaria
-- em silêncio o que outra migration pôs ali. Cada remendo confere que a âncora
-- aparece UMA vez, pula se já foi aplicado (a migration roda de novo) e para
-- com erro se a âncora sumiu.
--   * painel: termo vigente e quem é a escola no topo; por aluno, se o aceite
--     é de versão anterior e qual; por professor, se o aceite vale;
--   * job: o motivo do desmarque quando o termo mudou de versão;
--   * página pública (get_lesson_recording_consent_public, remendada também
--     por 20260926210000): o texto do termo sai já preenchido.
do $patches$
declare
  v_patch record;
  v_definition text;
  v_occurrences integer;
begin
  for v_patch in
    select * from (values
      (1, 'public.list_lesson_recording_consents()',
        $done$'term_identity', private.lesson_recording_school_identity(v_tenant)$done$,
        $anchor$    'ok', true,
    'google_connected', exists ($anchor$,
        $new$    'ok', true,
    -- Termo vigente e quem é a escola no texto (20260927100000).
    'term_identity', private.lesson_recording_school_identity(v_tenant),
    'term_versions', jsonb_build_object(
      'STUDENT', private.lesson_recording_current_version('STUDENT'),
      'TEACHER', private.lesson_recording_current_version('TEACHER')
    ),
    'google_connected', exists ($new$),
      (2, 'public.list_lesson_recording_consents()',
        $done$'term_updated', private.lesson_recording_accepted_outdated_term(student.id)$done$,
        $anchor$'effective', private.lesson_recording_student_consent_effective(student.id),$anchor$,
        $new$'effective', private.lesson_recording_student_consent_effective(student.id),
          -- Aceitou versão anterior à vigente: não vale até aceitar de novo.
          'term_updated', private.lesson_recording_accepted_outdated_term(student.id),
          'decided_term_version', private.lesson_recording_decided_term_version(student.id),$new$),
      (3, 'public.list_lesson_recording_consents()',
        $done$private.lesson_recording_teacher_consent_effective(teacher.id)$done$,
        $anchor$          'decided_at', last_decision.decided_at
        ) as row_data$anchor$,
        $new$          'decided_at', last_decision.decided_at,
          -- Só o aceite da versão vigente vale (20260927100000).
          'effective', private.lesson_recording_teacher_consent_effective(teacher.id),
          'term_updated', private.lesson_recording_accepted_outdated_term(teacher.id),
          'decided_term_version', private.lesson_recording_decided_term_version(teacher.id)
        ) as row_data$new$),
      (4, 'private.apply_standing_lesson_recording_consent(text)',
        $done$private.lesson_session_term_lapse_text(v_session.id)$done$,
        $anchor$': o aceite do aluno deixou de valer (hoje a escola exige o responsável).'$anchor$,
        $new$': ' || private.lesson_session_term_lapse_text(v_session.id)$new$),
      -- Página pública: o texto sai com a escola preenchida (PWA antigo em
      -- cache e qualquer leitor do term_body veem o controlador, não o marcador).
      (5, 'public.get_lesson_recording_consent_public(text)',
        $done$private.lesson_recording_fill_term(v_term.body, v_link.tenant_id)$done$,
        $anchor$'term_body', v_term.body,$anchor$,
        $new$'term_body', private.lesson_recording_fill_term(v_term.body, v_link.tenant_id),$new$)
    ) as patch(position, signature, done_marker, anchor, replacement)
    order by patch.position
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_patch.signature::pg_catalog.regprocedure);
    if pg_catalog.strpos(v_definition, v_patch.done_marker) > 0 then
      continue;
    end if;
    v_occurrences := (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_patch.anchor, '')))
      / pg_catalog.length(v_patch.anchor);
    if v_occurrences <> 1 then
      raise exception 'termo_v3_ancora_mudou: % (remendo %, % ocorrências)',
        v_patch.signature, v_patch.position, v_occurrences;
    end if;
    execute pg_catalog.replace(v_definition, v_patch.anchor, v_patch.replacement);
  end loop;
end
$patches$;

-- ---------------------------------------------------------------------------
-- 7. Retenção da memória das aulas (lado do banco)
-- ---------------------------------------------------------------------------

-- Prazos num lugar só (o termo v3 promete estes números).
create or replace function private.lesson_memory_retention_policy()
returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'lesson_excerpts_days', 90,
    'after_leaving_days', 90
  );
$$;

-- Quando o aluno DEIXOU a escola; nulo enquanto ele é aluno. "Deixou" é o
-- desligamento concluído (lifecycle_status = 'offboarded' e
-- offboarding_completed_at, gravados pelo fluxo de desligamento de
-- student_offboarding_operations). Suspenso ou "Inativo" com lifecycle
-- 'active' NÃO deixou a escola. Vale o que vier depois: a conclusão do
-- desligamento ou o fim do último dia de aula (offboarding_last_day, no fuso
-- da escola). Reativado (lifecycle volta a 'active'), deixa de contar.
create or replace function private.student_left_school_at(p_student uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case
    when pg_catalog.lower(pg_catalog.btrim(coalesce(student.lifecycle_status, ''))) = 'offboarded'
      and student.offboarding_completed_at is not null
    then greatest(
      student.offboarding_completed_at,
      case when student.offboarding_last_day is not null
        then ((student.offboarding_last_day + 1)::timestamp at time zone 'America/Sao_Paulo')
      end
    )
  end
  from public.profiles as student
  where student.id = p_student
    and student.role = 'STUDENT';
$$;

-- Trilha da retenção: SÓ contagens, por escola e rodada. Nunca texto, nome ou
-- id de aluno — o que foi apagado não pode sobreviver na trilha.
create table if not exists private.lesson_memory_retention_runs (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  ran_at timestamptz not null default pg_catalog.clock_timestamp(),
  tenant_id text not null,
  drafts_cleared integer not null default 0 check (drafts_cleared >= 0),
  approved_excerpts_cleared integer not null default 0 check (approved_excerpts_cleared >= 0),
  summaries_cleared integer not null default 0 check (summaries_cleared >= 0),
  memories_deleted integer not null default 0 check (memories_deleted >= 0),
  cards_deleted integer not null default 0 check (cards_deleted >= 0)
);
-- Banco que tenha a tabela de antes da coluna (clone de teste de uma versão
-- anterior desta migration, nunca publicada) ganha a coluna.
alter table private.lesson_memory_retention_runs
  add column if not exists approved_excerpts_cleared integer not null default 0
    check (approved_excerpts_cleared >= 0);
create index if not exists lesson_memory_retention_runs_tenant_idx
  on private.lesson_memory_retention_runs(tenant_id, ran_at desc);
comment on table private.lesson_memory_retention_runs is
  'Retenção da memória das aulas (20260927100000): contagens por escola e rodada — rascunhos e resumos aprovados que perderam os trechos da aula, resumos apagados, memórias MEET_SESSION e cartões apagados. Nunca conteúdo.';

alter table private.lesson_memory_retention_runs owner to postgres;
alter table private.lesson_memory_retention_runs enable row level security;
revoke all on private.lesson_memory_retention_runs from public, anon, authenticated, service_role;

-- A função de retenção (dono postgres) atualiza o conteúdo do resumo; a tabela
-- é do supabase_admin. Só as colunas que ela precisa.
grant select (id, tenant_id, lesson_session_id, status, content),
  update (content)
  on private.lesson_summary_versions to postgres;

-- (a) Toda versão de resumo — rascunho (PROPOSED/REJECTED) E aprovada
--     (VERIFIED) — perde narrative e evidence 90 dias depois do fim da aula.
--     narrative nasce como as anotações do Google na íntegra (rascunho das
--     notas nativas) e a aprovação guarda o que o professor manteve; evidence
--     são citações literais da transcrição. O termo promete 90 dias para esse
--     texto, e o resumo aprovado é lido por outros professores do aluno e pelo
--     suporte da plataforma. Objetivo, conteúdos, dificuldades, tarefa e
--     próximo passo ficam: são o resumo, e a memória do aluno
--     (student_learning_memories) usa só eles.
-- (b) Aluno que deixou a escola há mais de 90 dias: apaga a memória de origem
--     MEET_SESSION, o cartão do aluno e o conteúdo de todos os resumos das
--     aulas dele (a linha da versão fica, sem conteúdo, para a trilha de quem
--     aprovou e quando). Memória de outras origens não é tocada.
-- (c) Uma linha de contagens por escola afetada.
-- Re-executável: o que já foi limpo não casa de novo.
create or replace function private.purge_lesson_memory_retention()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb := private.lesson_memory_retention_policy();
  v_now timestamptz := pg_catalog.now();
  v_excerpts_cutoff timestamptz;
  v_left_cutoff timestamptz;
  v_run uuid := extensions.gen_random_uuid();
  v_drafts jsonb;
  v_approved jsonb;
  v_summaries jsonb;
  v_memories jsonb;
  v_cards jsonb;
begin
  v_excerpts_cutoff := v_now - pg_catalog.make_interval(days => (v_policy ->> 'lesson_excerpts_days')::integer);
  v_left_cutoff := v_now - pg_catalog.make_interval(days => (v_policy ->> 'after_leaving_days')::integer);

  -- Uma rodada por vez (cron atrasado e execução manual não se atropelam).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lesson-memory-retention', 0));

  -- (a) Trechos da aula em qualquer versão (rascunho e aprovada).
  with cleared as (
    update private.lesson_summary_versions as version
       set content = (version.content - 'narrative' - 'evidence')
         || jsonb_build_object('retention_raw_text_removed_at', v_now)
      from public.lesson_sessions as session
     where session.id = version.lesson_session_id
       and session.tenant_id = version.tenant_id
       and session.scheduled_end_at < v_excerpts_cutoff
       and (version.content ? 'narrative' or version.content ? 'evidence')
    returning version.tenant_id, version.status = 'VERIFIED' as approved
  ), counted as (
    select cleared.tenant_id,
      count(*) filter (where not cleared.approved)::integer as drafts,
      count(*) filter (where cleared.approved)::integer as approved
    from cleared
    group by cleared.tenant_id
  )
  select coalesce(jsonb_object_agg(counted.tenant_id, counted.drafts) filter (where counted.drafts > 0), '{}'::jsonb),
         coalesce(jsonb_object_agg(counted.tenant_id, counted.approved) filter (where counted.approved > 0), '{}'::jsonb)
    into v_drafts, v_approved
  from counted;

  -- (b1) Resumos das aulas de quem deixou a escola.
  with gone as (
    select student.id, student.tenant_id
    from public.profiles as student
    where student.role = 'STUDENT'
      and private.student_left_school_at(student.id) < v_left_cutoff
  ), cleared as (
    update private.lesson_summary_versions as version
       set content = jsonb_build_object(
         'retention_cleared_at', v_now,
         'retention_reason', 'student_left_school')
      from public.lesson_sessions as session, gone
     where session.id = version.lesson_session_id
       and session.tenant_id = version.tenant_id
       and session.student_id = gone.id
       and session.tenant_id = gone.tenant_id
       and (version.content - 'retention_cleared_at' - 'retention_reason'
         - 'retention_raw_text_removed_at') <> '{}'::jsonb
    returning version.tenant_id
  )
  select coalesce(jsonb_object_agg(counted.tenant_id, counted.total), '{}'::jsonb) into v_summaries
  from (select cleared.tenant_id, count(*)::integer as total from cleared group by cleared.tenant_id) as counted;

  -- (b2) Memória de origem MEET_SESSION de quem deixou a escola.
  with gone as (
    select student.id, student.tenant_id
    from public.profiles as student
    where student.role = 'STUDENT'
      and private.student_left_school_at(student.id) < v_left_cutoff
  ), deleted as (
    delete from public.student_learning_memories as memory
     using gone
     where memory.student_id = gone.id
       and memory.tenant_id = gone.tenant_id
       and memory.source_type = 'MEET_SESSION'
    returning memory.tenant_id
  )
  select coalesce(jsonb_object_agg(counted.tenant_id, counted.total), '{}'::jsonb) into v_memories
  from (select deleted.tenant_id, count(*)::integer as total from deleted group by deleted.tenant_id) as counted;

  -- (b3) Cartão do aluno de quem deixou a escola. O histórico do cartão
  --      (sem texto) ganha a linha da remoção, com o papel SYSTEM_RETENTION.
  with gone as (
    select student.id, student.tenant_id
    from public.profiles as student
    where student.role = 'STUDENT'
      and private.student_left_school_at(student.id) < v_left_cutoff
  ), deleted as (
    delete from public.student_learning_cards as card
     using gone
     where card.student_id = gone.id
       and card.tenant_id = gone.tenant_id
    returning card.tenant_id, card.student_id, card.version
  ), logged as (
    insert into private.student_learning_card_events (
      tenant_id, student_id, actor_id, actor_role, card_version, changed_fields
    )
    select deleted.tenant_id, deleted.student_id, null, 'SYSTEM_RETENTION', deleted.version,
      array['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics', 'notes']::text[]
    from deleted
    returning tenant_id
  )
  select coalesce(jsonb_object_agg(counted.tenant_id, counted.total), '{}'::jsonb) into v_cards
  from (select logged.tenant_id, count(*)::integer as total from logged group by logged.tenant_id) as counted;

  -- (c) Trilha: uma linha por escola com alguma coisa apagada.
  insert into private.lesson_memory_retention_runs (
    run_id, tenant_id, drafts_cleared, approved_excerpts_cleared, summaries_cleared, memories_deleted, cards_deleted
  )
  select v_run, affected.tenant_id,
    coalesce((v_drafts ->> affected.tenant_id)::integer, 0),
    coalesce((v_approved ->> affected.tenant_id)::integer, 0),
    coalesce((v_summaries ->> affected.tenant_id)::integer, 0),
    coalesce((v_memories ->> affected.tenant_id)::integer, 0),
    coalesce((v_cards ->> affected.tenant_id)::integer, 0)
  from (
    select jsonb_object_keys(v_drafts)
    union select jsonb_object_keys(v_approved)
    union select jsonb_object_keys(v_summaries)
    union select jsonb_object_keys(v_memories)
    union select jsonb_object_keys(v_cards)
  ) as affected(tenant_id);

  return jsonb_build_object(
    'run_id', v_run,
    'drafts_cleared', coalesce((select sum(value::integer) from jsonb_each_text(v_drafts)), 0),
    'approved_excerpts_cleared', coalesce((select sum(value::integer) from jsonb_each_text(v_approved)), 0),
    'summaries_cleared', coalesce((select sum(value::integer) from jsonb_each_text(v_summaries)), 0),
    'memories_deleted', coalesce((select sum(value::integer) from jsonb_each_text(v_memories)), 0),
    'cards_deleted', coalesce((select sum(value::integer) from jsonb_each_text(v_cards)), 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Donos e permissões
-- ---------------------------------------------------------------------------

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_clean_label(text,integer)',
    'private.lesson_recording_school_identity(text)',
    'private.lesson_recording_fill_term(text,text)',
    'private.lesson_recording_current_version(text)',
    'private.lesson_recording_decided_term_version(uuid)',
    'private.lesson_recording_accepted_outdated_term(uuid)',
    'private.lesson_recording_term_covers(text,text,timestamptz)',
    'private.lesson_recording_student_consent_effective_at(uuid,timestamptz)',
    'private.lesson_recording_student_consent_effective(uuid)',
    'private.lesson_recording_teacher_consent_effective_at(uuid,timestamptz)',
    'private.lesson_recording_teacher_consent_effective(uuid)',
    'private.lesson_recording_active_at(uuid,uuid,timestamptz)',
    'private.lesson_recording_active(uuid,uuid)',
    'private.lesson_session_term_consent_lapsed(uuid)',
    'private.lesson_session_term_lapse_text(uuid)',
    'private.lesson_recording_public_link_fields(uuid)',
    'private.lesson_memory_retention_policy()',
    'private.student_left_school_at(uuid)',
    'private.purge_lesson_memory_retention()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  -- Rotas do app e da página pública (a checagem de papel, de link e de código
  -- é interna). Mesmos grants das definições anteriores.
  foreach v_signature in array array[
    'public.get_my_lesson_recording_consent()',
    'public.set_my_lesson_recording_consent(boolean,text)',
    'public.decide_lesson_recording_consent_public(text,text,text,boolean,text,text)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
  grant execute on function public.get_my_lesson_recording_consent() to authenticated;
  grant execute on function public.set_my_lesson_recording_consent(boolean,text) to authenticated;
  -- Link público: token de 64 hex, 30 dias; a decisão exige o código de 6 dígitos.
  grant execute on function public.decide_lesson_recording_consent_public(text,text,text,boolean,text,text) to anon, authenticated;
end
$owners$;

-- Retenção diária, depois da limpeza das cópias brutas (05:17 UTC) e da
-- varredura do cartão (06:40 UTC fica depois; a ordem entre elas não importa).
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'wisewolf-lesson-memory-retention';
    perform cron.schedule('wisewolf-lesson-memory-retention', '23 6 * * *',
      'select private.purge_lesson_memory_retention();');
  end if;
end
$cron$;
