-- Registro das aulas autorizado pela ESCOLA (modo por escola), com direito de
-- pedir para não ser registrado (27/09/2026).
--
-- Decisão da direção (Vinícius, dono da escola, 27/09/2026): "Não quero ter que
-- gerar link para aluno ou professor consentir que a aula é transcrita. Já
-- deixe como autorizado. Nos próximos contratos de aluno e professor já vai a
-- cláusula." (a cláusula nos contratos é de outra frente).
--
-- ⚠️ Depende das ondas 1–3 (20260926170000 a 20260928130000): parte das
-- definições VIVAS delas. As funções pequenas da régua do aceite são recriadas
-- inteiras a partir da definição viva; as grandes, que outras frentes remendam,
-- recebem REMENDO POR ÂNCORA (pg_get_functiondef + erro se a âncora sumir).
--
-- 1. Modo de autorização POR ESCOLA (private.lesson_recording_authorization_modes,
--    trilha de cada troca: quem, quando, motivo, base):
--    * INDIVIDUAL_CONSENT — o modelo das ondas 1–3 (aceite individual pelo link,
--      com código; professor no app). É o padrão de escola sem linha: NADA muda
--      para as outras escolas.
--    * SCHOOL_DEFAULT — a escola autoriza o registro das aulas; cada pessoa pode
--      pedir para não ser registrada. Aluno e professor ATIVOS da escola têm a
--      autorização efetiva sem link, sem código, sem versão de termo e sem a
--      exigência de responsável/idade para AUTORIZAR (a direção incluiu os
--      menores; base proposta no RIPD, para o jurídico). A única coisa que tira
--      a autorização é o PEDIDO PARA NÃO REGISTRAR (recusa/revogação: pela
--      página pública, pelo professor no app ou registrado pela direção quando o
--      pedido chega pelo WhatsApp) — e ele vale na hora, com o mesmo efeito da
--      revogação da onda 1 (sala desligada, importação barrada, resumo por IA,
--      sugestões do cartão e lembrete com sala).
--    O modo vale pela hora: a aula segue o modo que valia no FIM previsto dela
--    (como a versão do termo). Aula já terminada não é autorizada nem barrada
--    por uma troca de modo posterior.
-- 2. A régua do aceite efetivo segue o modo (recriadas a partir da definição
--    viva): lesson_recording_student_consent_effective_at,
--    lesson_recording_teacher_consent_effective_at (e, por elas, *_effective,
--    lesson_recording_active(_at), o job apply_standing_lesson_recording_consent,
--    coverage_school_room_expected, painéis), lesson_recording_ai_accepted_at (e,
--    por ela, meet_summary_ai_consented e as sugestões do cartão),
--    lesson_teacher_documentation_ready (substituto e troca de professor),
--    lesson_recording_accepted_outdated_term / _acceptance_outdated_at (aceite
--    antigo não "cai" no modo da escola), lesson_session_term_consent_lapsed
--    (a aula marcada pelo padrão da escola cai quando a escola volta ao aceite
--    individual ou a pessoa deixa de estar ativa) e o texto do motivo.
--    lesson_session_documentation_blocked, get_my_lesson_rooms e
--    official_lesson_link não mudam: leem o aceite efetivo e o pedido para não
--    registrar pela régua de sempre (lesson_recording_said_no_before).
-- 3. NÃO muda: a conta Google do professor continua confirmada por login para ele
--    virar coanfitrião (sem ela, a aula dele não ganha sala e segue pelo link de
--    sempre); proteção de menor no cartão e na IA; retenção e exclusão.
-- 4. Texto v4 (aluno e professor) como AVISO (kind = 'NOTICE'), não termo de
--    aceite: mesmo conteúdo factual do v3, dizendo que o registro faz parte das
--    aulas da escola e que a pessoa pode pedir para não ser registrada a
--    qualquer momento. O aviso NUNCA vira o termo vigente do aceite individual
--    (lesson_recording_current_term e a régua de versão só olham kind = 'TERM')
--    — publicar o aviso não derruba aceite de escola que segue no modelo
--    individual.
-- 5. Pedido para não registrar e "desfazer": o registro da direção é a
--    revogação de sempre (revoke_lesson_recording_consent, REVOKED pela escola,
--    com motivo); desfazer é a decisão nova OBJECTION_WITHDRAWN
--    (withdraw_lesson_recording_objection, só a direção — SCHOOL_ADMIN —, com
--    motivo; o pedido que o próprio professor fez no app só ele desfaz, pelo
--    app). OBJECTION_WITHDRAWN não é aceite: no modelo individual a pessoa
--    segue sem resposta.
-- 6. Telas: link e envio em lote recusados no modo da escola
--    (registro_autorizado_pela_escola) — defesa no servidor além da tela; o
--    pedido que estava na fila é cancelado na hora de sair; painel, página,
--    cartão do professor, data de nascimento, "Sala e resumo" da aula passada a
--    outro professor e "Minhas aulas registradas" recebem o modo; Central de
--    Pendências ganha professores_sem_conta_google (só no modo da escola); os
--    tours leem o modo (my_lesson_recording_authorization_mode).
--    No modo da escola o job só MARCA a aula do professor com a conta Google
--    confirmada: sem ela não há sala, e a marca congelaria a sessão.
-- 7. Wise Wolf (school-wise-wolf) passa ao modo da escola por ONE-SHOT com
--    trilha (schema_one_shots), com a direção ativa como autora da decisão.
--
-- Re-executável: if not exists, drop/add constraint, create or replace, remendo
-- só quando a marca ainda não está na definição, one-shot guardado. Sem
-- begin/commit. SECURITY DEFINER nova: search_path = '' e dono postgres.

-- ---------------------------------------------------------------------------
-- 1. Aviso v4: termo de aceite (TERM) x aviso (NOTICE)
-- ---------------------------------------------------------------------------

alter table private.lesson_recording_terms add column if not exists kind text not null default 'TERM';
alter table private.lesson_recording_terms drop constraint if exists lesson_recording_terms_kind_check;
alter table private.lesson_recording_terms add constraint lesson_recording_terms_kind_check
  check (kind in ('TERM', 'NOTICE'));
comment on column private.lesson_recording_terms.kind is
  'TERM = termo de aceite individual (modelo INDIVIDUAL_CONSENT); NOTICE = aviso do registro autorizado pela escola (SCHOOL_DEFAULT). O aviso nunca é a versão exigida do aceite individual.';

insert into private.lesson_recording_terms (audience, version, body, kind) values
(
  'STUDENT', 'v4',
  $notice$Aviso sobre o registro das aulas

O registro das aulas faz parte das aulas da escola (está no contrato ou foi decidido pela escola). As aulas acontecem numa sala do Google Meet criada pela escola. Nessas salas, o Google transcreve a aula (transforma em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo. O Google também informa a que horas cada pessoa entrou e saiu da sala.

Você pode pedir para não ser registrado
• A qualquer momento, sem prejuízo das aulas: é só pedir pelo WhatsApp da escola (ou, se você recebeu o link deste aviso, pela própria página). A partir do pedido, as aulas seguintes acontecem normalmente, só que sem transcrição.
• Para menores de 18 anos, o pedido pode ser feito pelo responsável legal.

Para que usamos
• Dar continuidade às aulas: saber o que foi trabalhado em cada uma.
• Resumo da aula: depois de cada aula, um resumo é preparado automaticamente com ajuda de inteligência artificial (IA). Ele só entra na ficha do aluno depois que o professor lê, corrige se precisar e aprova.
• Planejar a próxima aula e a tarefa de casa, com ajuda de IA, a partir do resumo aprovado.
• Troca de professor: se o aluno passar para outro professor ou tiver aula com um substituto, esse professor recebe o histórico pedagógico (o dossiê) por um link que só abre com login na plataforma da escola.
• Cartão do aluno: o professor anota o objetivo do aluno, os temas que o engajam, os temas a evitar, como ele prefere ser corrigido e observações pedagógicas. A IA pode sugerir itens, mas só entra o que o professor revisar. Nunca guardamos informação sobre saúde, religião, política, família ou dinheiro. Para menores de 18 anos, o cartão guarda só interesses pedagógicos (objetivo e temas).
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
• Quando o relatório de presença não bate com o lançamento da aula, o caso aberto para a coordenação guarda os horários de entrada e saída daquela aula pelo tempo necessário para resolvê-lo (e para a escola exercer seus direitos).

Quando este aviso mudar
• A escola avisa de novo. O pedido para não ser registrado continua valendo.

Seus direitos
• Ver o seu registro: os resumos aprovados das suas aulas ficam no aplicativo da escola.
• Pedir para não ser registrado, a qualquer momento, pelo WhatsApp da escola. A partir daí as aulas seguintes deixam de ser transcritas.
• Pedir a exclusão do que já foi registrado, pelo WhatsApp da escola (menos o caso de presença aberto para a coordenação, descrito acima).
• Pedir informação, correção ou cópia dos seus dados pelo contato de privacidade abaixo.

Quem é responsável pelos dados
• A escola: {escola_nome}, {escola_documento}. Contato para assuntos de privacidade: {escola_contato_privacidade}.

Quem pede para não ser registrado continua tendo aula normalmente, só que sem transcrição.$notice$,
  'NOTICE'
),
(
  'TEACHER', 'v4',
  $notice$Aviso sobre o registro das suas aulas

O registro das aulas faz parte do trabalho com a escola (está no contrato ou foi decidido pela escola). As aulas da escola acontecem em salas do Google Meet criadas pela conta da escola, com você como coanfitrião, pela conta Google que você confirmou. Nessas salas, o Google transcreve a aula (transforma em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo.

Você pode pedir para não ser registrado
• A qualquer momento, sem prejuízo das suas aulas nem do seu pagamento: na tela "Salas e continuidade" ou pelo WhatsApp da escola. A partir do pedido, as suas aulas seguintes acontecem normalmente, só que sem transcrição.
• A sala da escola só é criada para as suas aulas depois que você confirma, por login, a conta Google com que entra nas aulas.

Para que usamos
• Continuidade pedagógica do aluno.
• Resumo da aula: depois de cada aula, um resumo é preparado automaticamente com ajuda de inteligência artificial (IA). Ele só entra na ficha do aluno depois que você lê, corrige se precisar e aprova.
• Planejar a próxima aula e a tarefa de casa, com ajuda de IA, a partir do resumo aprovado.
• Troca de professor: se o aluno passar para outro professor ou tiver aula com um substituto, esse professor recebe o dossiê pedagógico por um link que só abre com login na plataforma da escola.
• Cartão do aluno: você anota o objetivo, os temas que engajam, os temas a evitar, como o aluno prefere ser corrigido e observações pedagógicas. A IA pode sugerir itens, mas só entra o que você revisar. Nunca registre saúde, religião, política, família ou dinheiro. Para menores de 18 anos, só interesses pedagógicos (objetivo e temas).
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
• Quando o relatório de presença não bate com o lançamento da aula, o caso aberto para a coordenação guarda os horários de entrada e saída daquela aula pelo tempo necessário para resolvê-lo (e para as partes exercerem seus direitos).

Quando este aviso mudar
• A escola avisa de novo. O seu pedido para não ser registrado continua valendo.

Seus direitos
• Ver o registro das suas aulas no aplicativo.
• Pedir para não ser registrado quando quiser, nesta mesma tela ou pelo WhatsApp da escola. A partir daí, as suas aulas deixam de ser transcritas.
• Pedir a exclusão do que já foi registrado, pelo WhatsApp da escola (menos o caso de presença aberto para a coordenação, descrito acima).
• Pedir informação, correção ou cópia dos seus dados pelo contato de privacidade abaixo.

Quem é responsável pelos dados
• A escola: {escola_nome}, {escola_documento}. Contato para assuntos de privacidade: {escola_contato_privacidade}.$notice$,
  'NOTICE'
)
on conflict (audience, version) do nothing;

do $notice_check$
begin
  -- O aviso v4 carrega os três marcadores (o servidor preenche) e não pede aceite.
  if exists (
    select 1 from private.lesson_recording_terms as term
    where term.version = 'v4' and term.kind = 'NOTICE'
      and not (term.body like '%{escola_nome}%'
        and term.body like '%{escola_documento}%'
        and term.body like '%{escola_contato_privacidade}%')
  ) then
    raise exception 'aviso_v4_sem_marcadores_da_escola';
  end if;
  if exists (
    select 1 from private.lesson_recording_terms as term
    where term.version = 'v4' and (term.kind <> 'NOTICE' or term.body ~* 'autorizo')
  ) then
    raise exception 'aviso_v4_nao_e_aviso';
  end if;
  -- O aviso diz o mesmo que a cláusula dos contratos novos: o cartão inteiro
  -- (temas a evitar e observações) e o caso de presença que fica com a
  -- coordenação (e a ressalva na exclusão).
  if exists (
    select 1 from private.lesson_recording_terms as term
    where term.version = 'v4' and term.kind = 'NOTICE'
      and not (term.body like '%temas a evitar%'
        and term.body like '%observações pedagógicas%'
        and term.body like '%caso aberto para a coordenação%'
        and term.body like '%menos o caso de presença%'
        and term.body like '%contato de privacidade%')
  ) then
    raise exception 'aviso_v4_diverge_da_clausula_do_contrato';
  end if;
end
$notice_check$;

-- Termo de aceite vigente: só TERM (o aviso nunca é a versão exigida do aceite
-- individual). Recriada a partir da definição viva.
create or replace function private.lesson_recording_current_term(p_audience text)
returns private.lesson_recording_terms
language sql
stable security definer
set search_path = ''
as $function$
  select term.*
  from private.lesson_recording_terms as term
  where term.audience = p_audience
    and term.kind = 'TERM'
  order by term.published_at desc, term.version desc
  limit 1;
$function$;

create or replace function private.lesson_recording_current_notice(p_audience text)
returns private.lesson_recording_terms
language sql
stable security definer
set search_path = ''
as $function$
  select term.*
  from private.lesson_recording_terms as term
  where term.audience = p_audience
    and term.kind = 'NOTICE'
  order by term.published_at desc, term.version desc
  limit 1;
$function$;

-- Versão do aviso em vigor numa hora (a aula segue o texto do fim dela).
create or replace function private.lesson_recording_notice_version_at(p_audience text, p_at timestamptz)
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select term.version
  from private.lesson_recording_terms as term
  where term.audience = p_audience
    and term.kind = 'NOTICE'
    and (term.published_at <= p_at or p_at >= pg_catalog.now())
  order by term.published_at desc, term.version desc
  limit 1;
$function$;

-- A versão exigida do aceite é só entre os termos (TERM). Recriada a partir da
-- definição viva de 20260927100000 com o filtro do tipo.
create or replace function private.lesson_recording_term_covers(p_audience text, p_version text, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select (accepted.published_at, accepted.version) >= (required.published_at, required.version)
    from private.lesson_recording_terms as accepted
    cross join lateral (
      select term.published_at, term.version
      from private.lesson_recording_terms as term
      where term.audience = p_audience
        and term.kind = 'TERM'
        and (term.published_at <= p_at or p_at >= pg_catalog.now())
      order by term.published_at desc, term.version desc
      limit 1
    ) as required
    where accepted.audience = p_audience
      and accepted.version = p_version
      and accepted.kind = 'TERM'
  ), false);
$function$;

-- ---------------------------------------------------------------------------
-- 2. Decisão nova: desfazer o pedido para não registrar
-- ---------------------------------------------------------------------------

alter table private.lesson_recording_consents drop constraint if exists lesson_recording_consents_decision_check;
alter table private.lesson_recording_consents add constraint lesson_recording_consents_decision_check
  check (decision in ('ACCEPTED', 'REFUSED', 'REVOKED', 'OBJECTION_WITHDRAWN'));
alter table private.lesson_recording_consents drop constraint if exists lesson_recording_consents_check;
alter table private.lesson_recording_consents add constraint lesson_recording_consents_check
  check (
    (decision = 'REVOKED' and source = 'SCHOOL' and signer_relation = 'SCHOOL')
    -- Desfazer o pedido para não registrar (modo da escola): pela direção ou
    -- pelo próprio professor no app. NÃO é aceite: no modelo individual a
    -- pessoa segue sem resposta.
    or (decision = 'OBJECTION_WITHDRAWN' and source in ('SCHOOL', 'APP')
      and (term_audience is null or term_audience = subject_role))
    or (decision in ('ACCEPTED', 'REFUSED') and term_version is not null and term_audience = subject_role)
  );

-- ---------------------------------------------------------------------------
-- 3. Modo de autorização por escola, com trilha
-- ---------------------------------------------------------------------------

create table if not exists private.lesson_recording_authorization_modes (
  id bigint generated always as identity primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  mode text not null check (mode in ('SCHOOL_DEFAULT', 'INDIVIDUAL_CONSENT')),
  -- Transação do registro (now()): a aula segue o modo que valia no fim dela.
  effective_from timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_by_name text not null check (length(btrim(decided_by_name)) between 2 and 120),
  -- Dia da decisão da direção (pode ser anterior ao registro no sistema).
  decided_on date not null,
  reason text not null check (length(btrim(reason)) between 10 and 2000),
  legal_basis text not null check (legal_basis in (
    'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT', 'INDIVIDUAL_CONSENT')),
  source text not null check (source in ('MIGRATION', 'APP')),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists lesson_recording_authorization_modes_tenant_idx
  on private.lesson_recording_authorization_modes (tenant_id, effective_from desc, id desc);
alter table private.lesson_recording_authorization_modes owner to postgres;
alter table private.lesson_recording_authorization_modes enable row level security;
revoke all on private.lesson_recording_authorization_modes from public, anon, authenticated, service_role;
comment on table private.lesson_recording_authorization_modes is
  'Como cada escola autoriza o registro das aulas (20260929100000): SCHOOL_DEFAULT (a escola autoriza; cada pessoa pode pedir para não ser registrada) ou INDIVIDUAL_CONSENT (aceite individual pelo termo). Sem linha = INDIVIDUAL_CONSENT. Nunca update: cada troca é uma linha nova (trilha).';

create or replace function private.lesson_recording_authorization_mode(p_tenant text)
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select mode.mode
    from private.lesson_recording_authorization_modes as mode
    where mode.tenant_id = p_tenant
    order by mode.effective_from desc, mode.id desc
    limit 1
  ), 'INDIVIDUAL_CONSENT');
$function$;

create or replace function private.lesson_recording_authorization_mode_at(p_tenant text, p_at timestamptz)
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select mode.mode
    from private.lesson_recording_authorization_modes as mode
    where mode.tenant_id = p_tenant
      and mode.effective_from <= p_at
    order by mode.effective_from desc, mode.id desc
    limit 1
  ), 'INDIVIDUAL_CONSENT');
$function$;

-- Aluno ou professor ativo da escola (a mesma leitura do cadastro que as
-- automações usam: ciclo de vida ativo, sem status de inativo nem arquivado).
create or replace function private.lesson_recording_subject_active(p_subject uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select subject.role in ('STUDENT', 'TEACHER')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(subject.lifecycle_status, ''))) = 'active'
      and coalesce(subject.status, '') not in ('Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado')
      and coalesce(subject.status_financial, '') <> 'ARCHIVED'
    from public.profiles as subject
    where subject.id = p_subject
  ), false);
$function$;

-- A pessoa está coberta pela autorização da escola naquela hora? Modo da escola
-- dela na hora e papel de aluno/professor. "Ativo" é conferido para a aula que
-- ainda não terminou (e para "agora"); a aula que já terminou segue quem era da
-- escola — saída posterior não barra a aula já dada (a retenção cuida disso).
create or replace function private.lesson_recording_school_default_at(p_subject uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select private.lesson_recording_authorization_mode_at(subject.tenant_id, p_at) = 'SCHOOL_DEFAULT'
      and subject.role in ('STUDENT', 'TEACHER')
      and (p_at < pg_catalog.now() or private.lesson_recording_subject_active(subject.id))
    from public.profiles as subject
    where subject.id = p_subject
  ), false);
$function$;

-- Pedido para não registrar (a última decisão é recusa ou revogação).
create or replace function private.lesson_recording_objected(p_subject uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select private.lesson_recording_consent_state(p_subject) in ('REFUSED', 'REVOKED');
$function$;

-- O pedido para não registrar em vigor foi feito pelo próprio professor no app
-- (recusa com origem APP e relação SELF). Esse só ele desfaz ("Voltar a
-- registrar"): a direção não passa por cima da decisão da própria pessoa.
create or replace function private.lesson_recording_objection_by_self(p_subject uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select last_decision.decision in ('REFUSED', 'REVOKED')
      and last_decision.subject_role = 'TEACHER'
      and last_decision.source = 'APP'
      and last_decision.signer_relation = 'SELF'
    from (
      select consent.decision, consent.subject_role, consent.source, consent.signer_relation
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_subject
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$function$;

-- A decisão em vigor numa hora é pedido para não registrar.
create or replace function private.lesson_recording_objected_at(p_subject uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select decision.decision in ('REFUSED', 'REVOKED')
    from private.lesson_recording_consents as decision
    where decision.subject_id = p_subject
      and decision.decided_at <= p_at
    order by decision.decided_at desc, decision.seq desc
    limit 1
  ), false);
$function$;

-- Texto que a escola mostra: o aviso no modo da escola, o termo no individual.
create or replace function private.lesson_recording_text_for(p_tenant text, p_audience text)
returns private.lesson_recording_terms
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  v_text private.lesson_recording_terms;
begin
  if private.lesson_recording_authorization_mode(p_tenant) = 'SCHOOL_DEFAULT' then
    v_text := private.lesson_recording_current_notice(p_audience);
    if v_text.version is not null then
      return v_text;
    end if;
  end if;
  return private.lesson_recording_current_term(p_audience);
end;
$function$;

-- Resumo do modo para os painéis (sem dado pessoal além do nome de quem decidiu).
create or replace function private.lesson_recording_authorization_summary(p_tenant text)
returns jsonb
language sql
stable security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'mode', private.lesson_recording_authorization_mode(p_tenant),
    'current', (
      select pg_catalog.jsonb_build_object(
        'mode', mode.mode,
        'since', mode.effective_from,
        'decided_on', mode.decided_on,
        'decided_by_name', mode.decided_by_name,
        'reason', mode.reason,
        'legal_basis', mode.legal_basis,
        'source', mode.source)
      from private.lesson_recording_authorization_modes as mode
      where mode.tenant_id = p_tenant
      order by mode.effective_from desc, mode.id desc
      limit 1
    ),
    'history', coalesce((
      select pg_catalog.jsonb_agg(item order by item ->> 'since' desc)
      from (
        select pg_catalog.jsonb_build_object(
          'mode', mode.mode,
          'since', mode.effective_from,
          'decided_on', mode.decided_on,
          'decided_by_name', mode.decided_by_name,
          'reason', mode.reason,
          'source', mode.source) as item
        from private.lesson_recording_authorization_modes as mode
        where mode.tenant_id = p_tenant
        order by mode.effective_from desc, mode.id desc
        limit 10
      ) as recent
    ), '[]'::jsonb),
    'notice_versions', pg_catalog.jsonb_build_object(
      'STUDENT', (private.lesson_recording_current_notice('STUDENT')).version,
      'TEACHER', (private.lesson_recording_current_notice('TEACHER')).version),
    'can_change', exists (
      select 1 from public.profiles as me
      where me.id = (select auth.uid())
        and me.role = 'SCHOOL_ADMIN'
        and me.tenant_id = p_tenant
        and pg_catalog.lower(coalesce(me.lifecycle_status, '')) = 'active'
    )
  );
$function$;

-- ---------------------------------------------------------------------------
-- 4. A régua do aceite efetivo segue o modo (recriadas da definição viva)
-- ---------------------------------------------------------------------------

create or replace function private.lesson_recording_student_consent_effective_at(p_student uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select case
    -- 20260929100000: a escola autoriza; só o pedido para não registrar tira.
    -- Sem link, sem código, sem versão e sem exigir o responsável para
    -- AUTORIZAR (decisão da direção).
    when private.lesson_recording_school_default_at(p_student, p_at)
      then not private.lesson_recording_objected(p_student)
    else coalesce((
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
    ), false)
  end;
$function$;

create or replace function private.lesson_recording_teacher_consent_effective_at(p_teacher uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select case
    -- 20260929100000: a escola autoriza; só o pedido para não registrar tira.
    -- A conta Google continua exigida para a SALA (coanfitrião), não aqui.
    when private.lesson_recording_school_default_at(p_teacher, p_at)
      then not private.lesson_recording_objected(p_teacher)
    else coalesce((
      select last_decision.decision = 'ACCEPTED'
        and private.lesson_recording_term_covers('TEACHER', last_decision.term_version, p_at)
      from (
        select consent.decision, consent.term_version
        from private.lesson_recording_consents as consent
        where consent.subject_id = p_teacher
        order by consent.seq desc
        limit 1
      ) as last_decision
    ), false)
  end;
$function$;

-- IA só com texto que a declara: no modelo individual, o aceite do termo v3+
-- valendo no fim da aula; no modo da escola, o aviso em vigor no fim da aula
-- (v4 declara a IA) e nenhum pedido para não registrar até ali.
create or replace function private.lesson_recording_ai_accepted_at(p_subject uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select case
    when private.lesson_recording_school_default_at(p_subject, p_at)
      then not private.lesson_recording_objected_at(p_subject, p_at)
        and coalesce(private.lesson_recording_term_declares_ai(private.lesson_recording_notice_version_at(
          (select case when subject.role = 'TEACHER' then 'TEACHER' else 'STUDENT' end
             from public.profiles as subject where subject.id = p_subject),
          p_at)), false)
    else coalesce((
      select decision.decision = 'ACCEPTED'
        and private.lesson_recording_term_declares_ai(decision.term_version)
        and (decision.subject_role <> 'STUDENT' or decision.verification = 'WHATSAPP_CODE')
      from private.lesson_recording_consents as decision
      where decision.subject_id = p_subject
        and decision.decided_at <= p_at
      order by decision.decided_at desc, decision.seq desc
      limit 1
    ), false)
  end;
$function$;

-- Professor pronto para receber a aula (substituto, troca): conta Google
-- confirmada + autorização que vale no fim da aula (aceite do termo vigente,
-- ou o modo da escola sem pedido para não registrar).
create or replace function private.lesson_teacher_documentation_ready(p_teacher uuid, p_tenant text, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select exists (
      select 1 from private.teacher_google_identities as ident
      where ident.teacher_id = p_teacher and ident.tenant_id = p_tenant
    )
    and case
      when private.lesson_recording_school_default_at(p_teacher, p_at)
        then not private.lesson_recording_objected_at(p_teacher, p_at)
      else coalesce((
        select decision.decision = 'ACCEPTED'
          and private.lesson_recording_term_covers('TEACHER', decision.term_version, p_at)
        from private.lesson_recording_consents as decision
        where decision.subject_id = p_teacher
          and decision.decided_at <= p_at
        order by decision.decided_at desc, decision.seq desc
        limit 1
      ), false)
    end;
$function$;

-- Aceite de versão anterior só "cai" no modelo individual: no modo da escola o
-- aceite antigo é irrelevante (quem autoriza é a escola).
create or replace function private.lesson_recording_accepted_outdated_term(p_subject uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and last_decision.term_version is distinct from
        private.lesson_recording_current_version(last_decision.term_audience)
      and not private.lesson_recording_school_default_at(p_subject, pg_catalog.now())
    from (
      select consent.decision, consent.term_audience, consent.term_version
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_subject
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$function$;

create or replace function private.lesson_recording_acceptance_outdated_at(p_subject uuid, p_at timestamptz)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and not private.lesson_recording_term_covers(
        last_decision.term_audience, last_decision.term_version, p_at)
      and not private.lesson_recording_school_default_at(p_subject, p_at)
    from (
      select consent.decision, consent.term_audience, consent.term_version
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_subject
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$function$;

-- Autorização que CAI sem um "não" com hora: aula marcada pelo termo cuja
-- autorização deixou de valer no fim previsto.
--   * Marcada pelos dois ACEITES (modelo individual): como antes — os dois
--     seguem com o aceite gravado e ele deixou de valer (versão, responsável).
--   * Marcada pelo PADRÃO DA ESCOLA (o evento diz "registro autorizado pela
--     escola", 20260929100000): basta que ninguém tenha pedido para não
--     registrar (o "não" com hora é lesson_recording_said_no_before) — é o que
--     pega a aula quando a escola volta ao aceite individual ou a pessoa deixa
--     de estar ativa.
-- Aula marcada pelos aceites e passada a outro professor que nunca respondeu
-- NÃO cai aqui: é lesson_session_handover_unconsented (motivo próprio).
create or replace function private.lesson_session_term_consent_lapsed(p_session uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select coalesce(last_event.allowed and last_event.reason like 'Termo de registro das aulas%', false)
      and (
        (private.lesson_recording_consent_state(session.student_id) = 'ACCEPTED'
          and private.lesson_recording_consent_state(session.teacher_id) = 'ACCEPTED')
        or (last_event.reason like 'Termo de registro das aulas: registro autorizado pela escola%'
          and private.lesson_recording_consent_state(session.student_id) not in ('REFUSED', 'REVOKED')
          and private.lesson_recording_consent_state(session.teacher_id) not in ('REFUSED', 'REVOKED'))
      )
      and not private.lesson_recording_active_at(session.student_id, session.teacher_id, session.scheduled_end_at)
    from public.lesson_sessions as session
    left join lateral (
      select event.allowed, event.reason
      from private.lesson_documentation_consent_events as event
      where event.session_id = session.id
      order by event.created_at desc
      limit 1
    ) as last_event on true
    where session.id = p_session
  ), false);
$function$;

create or replace function private.lesson_session_term_lapse_text(p_session uuid)
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select coalesce((
    select case
      when private.lesson_recording_accepted_outdated_term(session.student_id)
        and private.lesson_recording_accepted_outdated_term(session.teacher_id)
        then 'o termo mudou de versão e o aluno (ou o responsável) e o professor ainda não aceitaram a versão vigente.'
      when private.lesson_recording_accepted_outdated_term(session.student_id)
        then 'o termo mudou de versão e o aluno (ou o responsável) ainda não aceitou a versão vigente.'
      when private.lesson_recording_accepted_outdated_term(session.teacher_id)
        then 'o termo mudou de versão e o professor ainda não aceitou a versão vigente.'
      -- 20260929100000: aula marcada pelo padrão da escola.
      when private.lesson_recording_authorization_mode(session.tenant_id) = 'INDIVIDUAL_CONSENT'
        and (private.lesson_recording_consent_state(session.student_id) <> 'ACCEPTED'
          or private.lesson_recording_consent_state(session.teacher_id) <> 'ACCEPTED')
        then 'a escola passou a pedir o aceite individual do registro e falta o aceite do aluno (ou do responsável) ou do professor.'
      when private.lesson_recording_authorization_mode(session.tenant_id) = 'SCHOOL_DEFAULT'
        then 'o aluno ou o professor não está mais ativo na escola.'
      else 'o aceite do aluno deixou de valer (hoje a escola exige o responsável).'
    end
    from public.lesson_sessions as session
    where session.id = p_session
  ), 'o aceite do termo deixou de valer.');
$function$;

-- ---------------------------------------------------------------------------
-- 5. Página pública, cartão do professor (recriadas da definição viva)
-- ---------------------------------------------------------------------------

create or replace function private.lesson_recording_public_link_fields(p_link_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  v_link private.lesson_recording_consent_links;
  v_reason text;
  v_decision text;
  v_verification text;
  v_decided_version text;
  v_effective boolean;
  v_outdated boolean;
  v_mode text;
begin
  select * into v_link from private.lesson_recording_consent_links where id = p_link_id;
  if not found then
    return '{}'::jsonb;
  end if;
  v_reason := private.lesson_recording_guardian_reason(v_link.student_id);
  v_mode := private.lesson_recording_authorization_mode(v_link.tenant_id);
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
    -- 20260929100000: SCHOOL_DEFAULT = a página mostra o AVISO e só o pedido
    -- para não registrar (sem aceite).
    'authorization_mode', v_mode,
    -- Aceite gravado que não vale: de versão anterior à vigente (o termo
    -- mudou), sem o código (versão anterior do link) ou dado pelo aluno quando
    -- hoje o cadastro exige o responsável. No modo da escola não se aplica.
    'current_not_effective_reason', case
      when v_mode = 'SCHOOL_DEFAULT' then null
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
$function$;

create or replace function public.decide_lesson_recording_consent_public(
  p_token text, p_signer_name text, p_relation text, p_accept boolean, p_code text,
  p_term_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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

  -- 20260929100000: na escola que autoriza o registro por padrão não há
  -- aceite — a página só grava o pedido para não registrar. Volta antes do
  -- código, sem gastá-lo.
  if p_accept and private.lesson_recording_authorization_mode(v_link.tenant_id) = 'SCHOOL_DEFAULT' then
    return jsonb_build_object('ok', false, 'error', 'registro_autorizado_pela_escola');
  end if;

  -- O aceite é do texto que a pessoa leu: versão diferente da vigente (ou não
  -- informada) volta antes do código, sem gastá-lo. No modo da escola, o texto
  -- é o aviso (só a recusa chega aqui).
  v_term := private.lesson_recording_text_for(v_link.tenant_id, 'STUDENT');
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
$function$;

create or replace function public.get_my_lesson_recording_consent()
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_last private.lesson_recording_consents;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    return jsonb_build_object('applies', false);
  end if;
  -- No modo da escola o texto é o aviso v4 (sem "Li e autorizo").
  v_term := private.lesson_recording_text_for(v_me.tenant_id, 'TEACHER');
  select * into v_last from private.lesson_recording_consents
   where subject_id = v_me.id order by seq desc limit 1;
  return jsonb_build_object(
    'applies', true,
    'authorization_mode', private.lesson_recording_authorization_mode(v_me.tenant_id),
    'decision', coalesce(v_last.decision, 'NONE'),
    'decided_at', v_last.decided_at,
    'decided_term_version', v_last.term_version,
    'effective', private.lesson_recording_teacher_consent_effective(v_me.id),
    -- Pediu para não registrar (recusa ou revogação é a última decisão).
    'objected', private.lesson_recording_objected(v_me.id),
    'term_updated', private.lesson_recording_accepted_outdated_term(v_me.id),
    'term_version', v_term.version,
    'term_kind', v_term.kind,
    -- Já preenchido: cartão em cache (PWA antigo) não mostra marcador cru.
    'term_body', private.lesson_recording_fill_term(v_term.body, v_me.tenant_id),
    'school_identity', private.lesson_recording_school_identity(v_me.tenant_id)
  );
end;
$function$;

create or replace function public.set_my_lesson_recording_consent(p_accept boolean, p_term_version text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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

  -- 20260929100000: a escola autoriza o registro por padrão. "Não quero" é o
  -- pedido para não registrar (vale na hora); "voltar a registrar" desfaz o
  -- pedido do próprio professor. Não há aceite a dar (nem conta Google a
  -- exigir aqui: ela continua exigida para a sala).
  if private.lesson_recording_authorization_mode(v_me.tenant_id) = 'SCHOOL_DEFAULT' then
    v_term := private.lesson_recording_text_for(v_me.tenant_id, 'TEACHER');
    if p_accept then
      if not private.lesson_recording_objected(v_me.id) then
        return jsonb_build_object('ok', true, 'decision', 'SCHOOL_DEFAULT', 'unchanged', true,
          'term_version', v_term.version);
      end if;
      insert into private.lesson_recording_consents (
        tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
        term_audience, term_version, source, recorded_by, reason
      ) values (
        v_me.tenant_id, v_me.id, 'TEACHER', 'OBJECTION_WITHDRAWN', left(btrim(v_me.full_name), 120), 'SELF',
        'TEACHER', v_term.version, 'APP', v_me.id,
        'O professor voltou a permitir o registro das próprias aulas pelo app.'
      );
      return jsonb_build_object('ok', true, 'decision', 'OBJECTION_WITHDRAWN', 'term_version', v_term.version);
    end if;
    v_version := coalesce((
      select term.version from private.lesson_recording_terms as term
      where term.audience = 'TEACHER' and term.version = p_term_version
    ), v_term.version);
    insert into private.lesson_recording_consents (
      tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
      term_audience, term_version, source, recorded_by, reason
    ) values (
      v_me.tenant_id, v_me.id, 'TEACHER', 'REFUSED', left(btrim(v_me.full_name), 120), 'SELF',
      'TEACHER', v_version, 'APP', v_me.id,
      'O professor pediu para não registrar as próprias aulas pelo app.'
    );
    return jsonb_build_object('ok', true, 'decision', 'REFUSED', 'term_version', v_version);
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
$function$;

-- ---------------------------------------------------------------------------
-- 6. Remendos por âncora nas definições vivas
-- ---------------------------------------------------------------------------

create or replace function pg_temp.lrm_patch(p_signature text, p_marker text, p_anchor text, p_replacement text)
returns void
language plpgsql
as $patch$
declare
  v_def text;
begin
  v_def := pg_catalog.pg_get_functiondef(p_signature::regprocedure);
  if strpos(v_def, p_marker) > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, p_anchor, ''))) / length(p_anchor) <> 1 then
    raise exception 'âncora de % não encontrada uma única vez: %', p_signature, p_anchor;
  end if;
  execute replace(v_def, p_anchor, p_replacement);
end
$patch$;

-- 6.1 O job diz por que marcou a aula.
select pg_temp.lrm_patch(
  'private.apply_standing_lesson_recording_consent(text)',
  'registro autorizado pela escola',
  $a$v_marker || ': aluno (ou responsável) e professor aceitaram o registro permanente.',$a$,
  $r$v_marker || case when private.lesson_recording_authorization_mode(p_tenant) = 'SCHOOL_DEFAULT'
          -- 20260929100000: o prefixo continua o do termo (é ele que diz
          -- "marcada pela régua", não à mão).
          then ': registro autorizado pela escola (ninguém da aula pediu para não ser registrado).'
          else ': aluno (ou responsável) e professor aceitaram o registro permanente.' end,$r$
);

-- 6.1b No modo da escola o job só marca a aula do professor com a conta Google
-- confirmada. A autorização da escola não depende da conta, mas a SALA sim
-- (coanfitrião): sem conta, PREPARE_ROOM nunca pega a aula, e marcar só a
-- congelaria (lesson_session_has_evidence) — a sessão deixaria de acompanhar a
-- agenda (troca de professor, replanejamento) sem ganhar sala nenhuma. Confirmada
-- a conta, a rodada seguinte (15 min) marca. No aceite individual nada muda: lá
-- o aceite do professor já exigiu a conta.
select pg_temp.lrm_patch(
  'private.apply_standing_lesson_recording_consent(text)',
  'só marca com a conta Google (20260929100000)',
  $a$      if v_connected and not v_session.documentation_consent and not v_session.manual_off then$a$,
  $r$      if v_connected and not v_session.documentation_consent and not v_session.manual_off
        -- Modo da escola: só marca com a conta Google (20260929100000).
        and (private.lesson_recording_authorization_mode(p_tenant) <> 'SCHOOL_DEFAULT'
          or exists (
            select 1 from private.teacher_google_identities as ident
            where ident.teacher_id = v_session.teacher_id and ident.tenant_id = p_tenant
          )) then$r$
);

-- 6.1c Aula passada a outro professor que não está pronto: no modo da escola
-- não há aceite a esperar — falta a conta Google (ou ele pediu para não ser
-- registrado, ou não está ativo).
select pg_temp.lrm_patch(
  'private.apply_standing_lesson_recording_consent(text)',
  'que ainda não confirmou a conta Google, pediu para não ter as aulas registradas',
  $a$then ': a aula passou para outro professor, que ainda não confirmou a conta Google ou não aceitou a versão vigente do termo.'$a$,
  $r$then case when private.lesson_recording_authorization_mode(p_tenant) = 'SCHOOL_DEFAULT'
            then ': a aula passou para outro professor, que ainda não confirmou a conta Google, pediu para não ter as aulas registradas ou não está ativo na escola.'
            else ': a aula passou para outro professor, que ainda não confirmou a conta Google ou não aceitou a versão vigente do termo.' end$r$
);

-- 6.1d "Sala e resumo" diz o remédio certo da aula passada a quem não está
-- pronto: no modo da escola não há aceite a dar (confirmar a conta Google ou
-- desfazer o pedido). Recriada da definição viva de 20260928110000 com o modo
-- que valia no fim da aula e a conta Google de quem recebeu a aula.
create or replace function private.lesson_session_last_handover(p_session uuid)
returns jsonb
language sql
stable security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'from_teacher_name', from_teacher.full_name,
    'to_teacher_name', to_teacher.full_name,
    'cause', handover.cause,
    'at', handover.created_at,
    'documentation_ready', handover.documentation_ready,
    'after_lesson', handover.after_lesson,
    -- 20260929100000
    'authorization_mode', private.lesson_recording_authorization_mode_at(session.tenant_id, session.scheduled_end_at),
    'to_teacher_google_confirmed', exists (
      select 1 from private.teacher_google_identities as ident
      where ident.teacher_id = handover.to_teacher_id and ident.tenant_id = session.tenant_id
    ))
  from private.lesson_session_teacher_handovers as handover
  join public.lesson_sessions as session on session.id = handover.session_id
  join public.profiles as from_teacher on from_teacher.id = handover.from_teacher_id
  join public.profiles as to_teacher on to_teacher.id = handover.to_teacher_id
  where handover.session_id = p_session
  order by handover.created_at desc
  limit 1;
$function$;

-- 6.2 Página pública: no modo da escola o texto é o aviso.
select pg_temp.lrm_patch(
  'public.get_lesson_recording_consent_public(text)',
  'lesson_recording_text_for(v_link.tenant_id',
  $a$  v_term := private.lesson_recording_current_term('STUDENT');$a$,
  $r$  -- 20260929100000: no modo da escola o texto é o aviso (sem aceite).
  v_term := private.lesson_recording_text_for(v_link.tenant_id, 'STUDENT');$r$
);
-- Link bloqueado, vencido ou revogado (o pedido registrado pela direção revoga
-- o link): no modo da escola não há link novo a pedir — a página manda falar
-- com a escola pelo WhatsApp. Só com o link achado (o token é da escola dele).
select pg_temp.lrm_patch(
  'public.get_lesson_recording_consent_public(text)',
  $m$'blocked', true, 'authorization_mode'$m$,
  $a$    return jsonb_build_object('found', false, 'expired', true, 'blocked', true);$a$,
  $r$    return jsonb_build_object('found', false, 'expired', true, 'blocked', true, 'authorization_mode',
      private.lesson_recording_authorization_mode(v_link.tenant_id));$r$
);
select pg_temp.lrm_patch(
  'public.get_lesson_recording_consent_public(text)',
  $m$'expired', found, 'authorization_mode'$m$,
  $a$    return jsonb_build_object('found', false, 'expired', found);$a$,
  $r$    return jsonb_build_object('found', false, 'expired', found, 'authorization_mode',
      case when v_link.id is not null then private.lesson_recording_authorization_mode(v_link.tenant_id) end);$r$
);

-- 6.2b Data de nascimento (painel e ficha): no modo da escola a idade não
-- decide quem AUTORIZA — só quem pode pedir para não registrar.
select pg_temp.lrm_patch(
  'public.get_student_birth_date_record(uuid)',
  $m$'authorization_mode'$m$,
  $a$    'guardian_phone_unconfirmed', private.lesson_recording_guardian_phone_unconfirmed(p_student_id)$a$,
  $r$    'guardian_phone_unconfirmed', private.lesson_recording_guardian_phone_unconfirmed(p_student_id),
    -- 20260929100000: como a escola autoriza o registro.
    'authorization_mode', private.lesson_recording_authorization_mode(v_student.tenant_id)$r$
);

-- 6.3 Painel de autorizações: o modo e a trilha; conta Google do professor.
select pg_temp.lrm_patch(
  'public.list_lesson_recording_consents()',
  'lesson_recording_authorization_summary',
  $a$    -- Termo vigente e quem é a escola no texto (20260927100000).$a$,
  $r$    -- Como a escola autoriza o registro, com a trilha (20260929100000).
    'authorization', private.lesson_recording_authorization_summary(v_tenant),
    -- Termo vigente e quem é a escola no texto (20260927100000).$r$
);
select pg_temp.lrm_patch(
  'public.list_lesson_recording_consents()',
  'google_identity_confirmed',
  $a$'decided_term_version', private.lesson_recording_decided_term_version(teacher.id)$a$,
  $r$'decided_term_version', private.lesson_recording_decided_term_version(teacher.id),
          -- Sem conta Google confirmada, a sala da escola não nasce para ele
          -- (20260929100000: a autorização da escola não dispensa isso).
          'google_identity_confirmed', exists (
            select 1 from private.teacher_google_identities as ident
            where ident.teacher_id = teacher.id and ident.tenant_id = v_tenant
          ),
          -- O pedido para não registrar foi do próprio professor no app: só
          -- ele desfaz (o painel não oferece "Desfazer pedido").
          'objection_by_self', private.lesson_recording_objection_by_self(teacher.id)$r$
);

-- 6.4 "Minhas aulas registradas": aviso, situação e modo.
select pg_temp.lrm_patch(
  'public.get_my_lesson_records()',
  $m$lesson_recording_text_for(v_me.tenant_id, 'STUDENT')$m$,
  $a$  v_term := private.lesson_recording_current_term('STUDENT');$a$,
  $r$  -- 20260929100000: no modo da escola o texto é o aviso.
  v_term := private.lesson_recording_text_for(v_me.tenant_id, 'STUDENT');$r$
);
select pg_temp.lrm_patch(
  'public.get_my_lesson_records()',
  $m$'SCHOOL_AUTHORIZED'$m$,
  $a$  v_status := case
    when v_decision is null then 'NONE'$a$,
  $r$  v_status := case
    -- 20260929100000: a escola autoriza; só o pedido para não registrar tira.
    when private.lesson_recording_authorization_mode(v_me.tenant_id) = 'SCHOOL_DEFAULT'
      and coalesce(v_decision, '') not in ('REFUSED', 'REVOKED') then
      case when private.lesson_recording_student_consent_effective(v_me.id)
        then 'SCHOOL_AUTHORIZED' else 'NONE' end
    when v_decision is null then 'NONE'
    -- Desfazer o pedido não é aceite: no modelo individual é "sem resposta".
    when v_decision = 'OBJECTION_WITHDRAWN' then 'NONE'$r$
);
select pg_temp.lrm_patch(
  'public.get_my_lesson_records()',
  $m$'authorization_mode', private.lesson_recording_authorization_mode(v_me.tenant_id)$m$,
  $a$    'school_whatsapp', v_school_whatsapp,$a$,
  $r$    'school_whatsapp', v_school_whatsapp,
    'authorization_mode', private.lesson_recording_authorization_mode(v_me.tenant_id),$r$
);

-- 6.5 Envio em lote: ninguém é "pendente" no modo da escola; a mensagem que
-- estava na fila é cancelada na hora de sair.
select pg_temp.lrm_patch(
  'private.lesson_recording_request_roster(text)',
  'registro autorizado pela escola',
  $a$    case
      when last_decision.decision is null then true$a$,
  $r$    case
      -- 20260929100000: registro autorizado pela escola — não há termo a pedir.
      when private.lesson_recording_authorization_mode(p_tenant) = 'SCHOOL_DEFAULT' then false
      when last_decision.decision is null then true$r$
);
select pg_temp.lrm_patch(
  'private.lesson_recording_request_snapshot_at(uuid,timestamp with time zone)',
  'registro_autorizado_pela_escola',
  $a$  v_term := private.lesson_recording_current_term('STUDENT');
  if v_term.version is distinct from v_request.term_version then$a$,
  $r$  -- 20260929100000: a escola passou a autorizar o registro por padrão.
  if private.lesson_recording_authorization_mode(v_queue.tenant_id) = 'SCHOOL_DEFAULT' then
    return jsonb_build_object('ok', false, 'reason', 'registro_autorizado_pela_escola');
  end if;
  v_term := private.lesson_recording_current_term('STUDENT');
  if v_term.version is distinct from v_request.term_version then$r$
);

-- 6.6 Link e envio do termo recusados no modo da escola (defesa no servidor;
-- a tela já não oferece).
select pg_temp.lrm_patch(
  signature,
  'registro_autorizado_pela_escola',
  $a$  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;$a$,
  $r$  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  -- 20260929100000: escola que autoriza o registro por padrão não pede termo.
  if private.lesson_recording_authorization_mode(v_tenant) = 'SCHOOL_DEFAULT' then
    raise exception 'registro_autorizado_pela_escola' using errcode = '22023';
  end if;$r$
)
from unnest(array[
  'public.enqueue_lesson_recording_consent_batch(integer)',
  'public.preview_lesson_recording_consent_batch()',
  'public.resend_lesson_recording_consent_request(uuid)'
]) as signature;

select pg_temp.lrm_patch(
  'public.create_lesson_recording_consent_link(uuid)',
  'registro_autorizado_pela_escola',
  $a$  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;$a$,
  $r$  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  -- 20260929100000: escola que autoriza o registro por padrão não gera link
  -- (quem já tem um vivo ainda pode abrir e pedir para não ser registrado).
  if private.lesson_recording_authorization_mode(v_student.tenant_id) = 'SCHOOL_DEFAULT' then
    raise exception 'registro_autorizado_pela_escola' using errcode = '22023';
  end if;$r$
);

select pg_temp.lrm_patch(
  'public.list_lesson_recording_consent_requests()',
  $m$'authorization_mode'$m$,
  $a$    'can_send', private.lesson_recording_is_direction(v_tenant),$a$,
  $r$    'can_send', private.lesson_recording_is_direction(v_tenant)
      and private.lesson_recording_authorization_mode(v_tenant) <> 'SCHOOL_DEFAULT',
    'authorization_mode', private.lesson_recording_authorization_mode(v_tenant),$r$
);

-- 6.7 Central de Pendências: professor sem conta Google confirmada (a sala da
-- escola só nasce depois disso), com aula nos próximos 14 dias. Só no modo da
-- escola: no aceite individual a sala depende também dos dois aceites, e o
-- item diria à escola que a conta basta — lá a pendência continua sendo o
-- termo (o painel de autorizações).
create or replace function private.lesson_recording_teachers_without_google_identity(p_tenant text)
returns integer
language sql
stable security definer
set search_path = ''
as $function$
  select case when p_tenant is null
    or private.lesson_recording_authorization_mode(p_tenant) <> 'SCHOOL_DEFAULT'
    or not exists (
      select 1 from private.google_workspace_connections as connection
      where connection.tenant_id = p_tenant and connection.status = 'CONNECTED'
    ) then 0
  else (
    select pg_catalog.count(distinct session.teacher_id)::integer
    from public.lesson_sessions as session
    join public.profiles as teacher on teacher.id = session.teacher_id
    where session.tenant_id = p_tenant
      and session.status = 'SCHEDULED'
      and session.scheduled_start_at between pg_catalog.now() and pg_catalog.now() + interval '14 days'
      and teacher.role = 'TEACHER'
      and private.lesson_recording_subject_active(teacher.id)
      -- Quem pediu para não registrar não precisa de sala da escola.
      and not private.lesson_recording_objected(teacher.id)
      and not exists (
        select 1 from private.teacher_google_identities as ident
        where ident.teacher_id = teacher.id and ident.tenant_id = p_tenant
      )
  ) end;
$function$;

select pg_temp.lrm_patch(
  'public.director_pending_counts()',
  'professores_sem_conta_google',
  $a$    || pg_catalog.jsonb_build_object('resumos_para_revisar', private.meet_summary_review_stale_count(v_tenant_id))$a$,
  $r$    || pg_catalog.jsonb_build_object('resumos_para_revisar', private.meet_summary_review_stale_count(v_tenant_id))
    -- Professor sem conta Google confirmada com aula nos próximos 14 dias
    -- (20260929100000): a sala da escola só nasce depois da confirmação.
    || pg_catalog.jsonb_build_object('professores_sem_conta_google',
      private.lesson_recording_teachers_without_google_identity(v_tenant_id))$r$
);

-- ---------------------------------------------------------------------------
-- 7. RPCs novas
-- ---------------------------------------------------------------------------

-- Como a escola de quem está logado autoriza o registro. Os tours de novidade
-- (lib/featureTours.ts) usam para não mostrar o do termo a quem está no modo da
-- escola, nem o do modo da escola a quem segue no aceite individual. Sem escola,
-- nulo (o app não abre tour que dependa do modo).
create or replace function public.my_lesson_recording_authorization_mode()
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select case when public._my_tenant_id() is null then null
    else private.lesson_recording_authorization_mode(public._my_tenant_id()) end;
$function$;

-- A direção troca o modo, com motivo e trilha. Vale na hora: o job roda em
-- seguida (marca as próximas 24 h no modo da escola; desmarca as aulas que o
-- padrão tinha marcado quando a escola volta ao aceite individual).
create or replace function public.set_lesson_recording_authorization_mode(p_mode text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant text := public._my_tenant_id();
  v_me public.profiles;
  v_reason text := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
  v_changed integer;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if v_tenant is null or v_me.id is null or v_me.role <> 'SCHOOL_ADMIN' or v_me.tenant_id is distinct from v_tenant
    or pg_catalog.lower(coalesce(v_me.lifecycle_status, '')) <> 'active' then
    raise exception 'somente_a_direcao' using errcode = '42501';
  end if;
  if coalesce(p_mode, '') not in ('SCHOOL_DEFAULT', 'INDIVIDUAL_CONSENT') then
    raise exception 'modo_invalido' using errcode = '22023';
  end if;
  if length(v_reason) < 10 then
    raise exception 'informe_o_motivo' using errcode = '22023';
  end if;
  if p_mode = 'SCHOOL_DEFAULT' and (
    (private.lesson_recording_current_notice('STUDENT')).version is null
    or (private.lesson_recording_current_notice('TEACHER')).version is null
  ) then
    raise exception 'aviso_nao_publicado' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lesson-recording-mode:' || v_tenant, 0));
  if private.lesson_recording_authorization_mode(v_tenant) = p_mode then
    return jsonb_build_object('ok', true, 'mode', p_mode, 'unchanged', true);
  end if;

  insert into private.lesson_recording_authorization_modes (
    tenant_id, mode, decided_by, decided_by_name, decided_on, reason, legal_basis, source
  ) values (
    v_tenant, p_mode, v_me.id,
    left(coalesce(nullif(btrim(v_me.full_name), ''), 'Direção da escola'), 120),
    (pg_catalog.now() at time zone 'America/Sao_Paulo')::date,
    left(v_reason, 2000),
    case p_mode when 'SCHOOL_DEFAULT' then 'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT' else 'INDIVIDUAL_CONSENT' end,
    'APP'
  );
  v_changed := private.apply_standing_lesson_recording_consent(v_tenant);
  return jsonb_build_object('ok', true, 'mode', p_mode, 'sessions_changed', coalesce(v_changed, 0));
end;
$function$;

-- A direção desfaz um pedido para não registrar (a pessoa pediu pelo WhatsApp
-- para voltar a ser registrada, ou o pedido foi registrado por engano). Só no
-- modo da escola: no aceite individual, quem recusou responde de novo pelo
-- termo.
--   * Só a DIREÇÃO (SCHOOL_ADMIN): desfazer volta a ligar sala, importação e IA
--     de alguém que pediu para não ser registrado. A coordenação registra o
--     pedido (revoke_lesson_recording_consent, que só restringe), não o desfaz.
--   * O pedido que o PRÓPRIO professor fez no app só ele desfaz ("Voltar a
--     registrar minhas aulas"): a escola não passa por cima da decisão dele.
--   * O pedido do aluno ou do responsável (página ou WhatsApp) a direção desfaz
--     a pedido da família, com o motivo — no modo da escola é o único caminho
--     dela (a página só grava o pedido para não registrar).
create or replace function public.withdraw_lesson_recording_objection(p_subject_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subject public.profiles;
  v_me public.profiles;
  v_notice private.lesson_recording_terms;
begin
  select * into v_subject from public.profiles where id = p_subject_id;
  if not found or v_subject.role not in ('STUDENT', 'TEACHER') then
    raise exception 'pessoa_invalida' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_subject.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles as actor
    where actor.id = (select auth.uid())
      and actor.role = 'SCHOOL_ADMIN'
      and actor.tenant_id = v_subject.tenant_id
      and pg_catalog.lower(coalesce(actor.lifecycle_status, '')) = 'active'
  ) then
    raise exception 'somente_a_direcao' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'informe_o_motivo' using errcode = '22023';
  end if;
  if private.lesson_recording_authorization_mode(v_subject.tenant_id) <> 'SCHOOL_DEFAULT' then
    raise exception 'so_no_registro_autorizado_pela_escola' using errcode = '22023';
  end if;
  if not private.lesson_recording_objected(v_subject.id) then
    raise exception 'nao_ha_pedido_para_desfazer' using errcode = '22023';
  end if;
  if private.lesson_recording_objection_by_self(v_subject.id) then
    raise exception 'pedido_do_proprio_professor' using errcode = '22023';
  end if;
  select * into v_me from public.profiles where id = (select auth.uid());
  v_notice := private.lesson_recording_current_notice(v_subject.role);

  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, recorded_by, reason
  ) values (
    v_subject.tenant_id, v_subject.id, v_subject.role, 'OBJECTION_WITHDRAWN',
    left(coalesce(nullif(btrim(v_me.full_name), ''), 'Escola'), 120), 'SCHOOL',
    case when v_notice.version is null then null else v_subject.role end, v_notice.version,
    'SCHOOL', v_me.id, left(btrim(p_reason), 2000)
  );
  return jsonb_build_object('ok', true, 'decision', 'OBJECTION_WITHDRAWN');
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Wise Wolf: registro autorizado pela escola (one-shot com trilha)
-- ---------------------------------------------------------------------------

-- Função própria para o teste reproduzir o one-shot (idempotente por si:
-- não grava a decisão duas vezes).
create or replace function private.lesson_recording_school_default_decision_20260927(p_tenant text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_actor_name text;
begin
  if not exists (select 1 from public.tenants as tenant where tenant.id = p_tenant) then
    return 'tenant_absent';
  end if;
  if exists (
    select 1 from private.lesson_recording_authorization_modes as mode
    where mode.tenant_id = p_tenant and mode.source = 'MIGRATION' and mode.decided_on = date '2026-09-27'
  ) then
    return 'already';
  end if;
  -- Quem decidiu: a direção ativa da escola (o SCHOOL_ADMIN, antes da
  -- coordenação — a mesma régua do autor das ações do grupo da Gestão).
  v_actor := private.management_group_default_actor(p_tenant);
  select nullif(btrim(profile.full_name), '') into v_actor_name
  from public.profiles as profile where profile.id = v_actor;

  insert into private.lesson_recording_authorization_modes (
    tenant_id, mode, decided_by, decided_by_name, decided_on, reason, legal_basis, source
  ) values (
    p_tenant, 'SCHOOL_DEFAULT', v_actor,
    left(coalesce(v_actor_name, 'Direção da escola'), 120),
    date '2026-09-27',
    'Decisão da direção (dono da escola), 27/09/2026: "Não quero ter que gerar link para aluno ou professor consentir que a aula é transcrita. Já deixe como autorizado. Nos próximos contratos de aluno e professor já vai a cláusula." Base: contrato/decisão da escola, com direito de cada pessoa pedir para não ser registrada (inclusive o responsável, para menor).',
    'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT',
    'MIGRATION'
  );
  return 'applied';
end;
$function$;

do $one_shot$
declare
  v_result text;
begin
  if not exists (
    select 1 from public.schema_one_shots
    where key = 'registro_das_aulas_autorizado_pela_escola_wise_wolf_20260927'
  ) then
    v_result := private.lesson_recording_school_default_decision_20260927('school-wise-wolf');
    -- Sem a escola (clone só-estrutura, outro ambiente) não marca: nada foi feito.
    if v_result in ('applied', 'already') then
      insert into public.schema_one_shots (key, nota)
      values ('registro_das_aulas_autorizado_pela_escola_wise_wolf_20260927',
        'Wise Wolf passa ao registro das aulas autorizado pela escola (SCHOOL_DEFAULT), decisão da direção de 27/09/2026; trilha em private.lesson_recording_authorization_modes.');
    end if;
  end if;
end
$one_shot$;

-- ---------------------------------------------------------------------------
-- 9. Donos e permissões
-- ---------------------------------------------------------------------------

do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_current_term(text)',
    'private.lesson_recording_current_notice(text)',
    'private.lesson_recording_notice_version_at(text,timestamp with time zone)',
    'private.lesson_recording_term_covers(text,text,timestamp with time zone)',
    'private.lesson_recording_authorization_mode(text)',
    'private.lesson_recording_authorization_mode_at(text,timestamp with time zone)',
    'private.lesson_recording_subject_active(uuid)',
    'private.lesson_recording_school_default_at(uuid,timestamp with time zone)',
    'private.lesson_recording_objected(uuid)',
    'private.lesson_recording_objection_by_self(uuid)',
    'private.lesson_recording_objected_at(uuid,timestamp with time zone)',
    'private.lesson_recording_text_for(text,text)',
    'private.lesson_recording_authorization_summary(text)',
    'private.lesson_recording_student_consent_effective_at(uuid,timestamp with time zone)',
    'private.lesson_recording_teacher_consent_effective_at(uuid,timestamp with time zone)',
    'private.lesson_recording_ai_accepted_at(uuid,timestamp with time zone)',
    'private.lesson_teacher_documentation_ready(uuid,text,timestamp with time zone)',
    'private.lesson_recording_accepted_outdated_term(uuid)',
    'private.lesson_recording_acceptance_outdated_at(uuid,timestamp with time zone)',
    'private.lesson_session_term_consent_lapsed(uuid)',
    'private.lesson_session_term_lapse_text(uuid)',
    'private.lesson_recording_public_link_fields(uuid)',
    'private.lesson_recording_teachers_without_google_identity(text)',
    'private.lesson_session_last_handover(uuid)',
    'private.lesson_recording_school_default_decision_20260927(text)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;

  -- Rotas novas do app (logado): quem pode, decide a própria função. As
  -- recriadas (get_my_/set_my_lesson_recording_consent e a rota anônima
  -- decide_lesson_recording_consent_public, auditada em
  -- security_definer_authorization_hardening.sql) mantêm assinatura, dono e
  -- EXECUTE de antes — create or replace não mexe no ACL.
  foreach v_signature in array array[
    'public.set_lesson_recording_authorization_mode(text,text)',
    'public.withdraw_lesson_recording_objection(uuid,text)',
    'public.my_lesson_recording_authorization_mode()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end
$grants$;
