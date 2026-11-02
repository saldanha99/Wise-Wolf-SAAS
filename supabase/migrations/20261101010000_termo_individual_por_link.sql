-- Termo individual por link no WhatsApp (decisão da direção, 31/10/2026).
-- Antes o professor (e a escola) só assinavam entrando no portal: o termo da
-- Amábile levou 3 dias só para a escola assinar. Agora cada parte recebe um
-- link pessoal no próprio WhatsApp, abre sem login, confere e assina digitando
-- o nome. A assinatura continua sendo a da própria pessoa: o link só age como
-- quem o recebeu, pela MESMA RPC do portal (public.teacher_student_terms).
-- Escola e professor podem assinar em qualquer ordem; o termo só executa com as
-- duas assinaturas e a confirmação da agenda pela família, como antes.
-- Nada de valor pago pelo aluno aparece na página ou nas mensagens.

create table if not exists private.student_term_links(
 token_hash text primary key,
 term_id uuid not null references private.teacher_student_terms(id),
 signer text not null check(signer in('SCHOOL','TEACHER')),
 signer_id uuid not null references public.profiles(id),
 phone text not null,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 opened_at timestamptz,
 used_at timestamptz,
 revoked_at timestamptz,
 reminded_at timestamptz);
create index if not exists student_term_links_open on private.student_term_links(term_id,signer) where used_at is null and revoked_at is null;
alter table private.student_term_links owner to postgres;
alter table private.student_term_links enable row level security;
revoke all on private.student_term_links from public,anon,authenticated,service_role;

-- 1. Escola e professor assinam em qualquer ordem.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.teacher_student_terms(text,uuid,jsonb)'::regprocedure);
 anchor:=E'   if r.school_signed_at is null then raise exception ''Aguarde a manifestação da escola sobre esta versão.'';end if;\n';
 if strpos(s,anchor)>0 then s:=replace(s,anchor,'');end if;
 anchor:='update private.teacher_student_terms set school_signed_by=uid,school_signed_at=clock_timestamp(),school_typed_name=name,updated_at=now() where id=r.id;';
 if strpos(s,anchor)>0 then
  s:=replace(s,anchor,'update private.teacher_student_terms set school_signed_by=uid,school_signed_at=clock_timestamp(),school_typed_name=name,status=case when teacher_signed_at is not null and family_confirmed_at is not null then ''EXECUTED'' else status end,updated_at=now() where id=r.id;');
 elsif strpos(s,'school_typed_name=name,status=case when teacher_signed_at is not null')=0 then
  raise exception 'term_school_sign_anchor_changed';
 end if;
 execute s;
end;$patch$;

-- 2. Modelo jurídico 2 (aprovado pela direção em 31/10/2026): multas próprias
-- para aula registrada sem ter sido dada (devolução + 10x por unidade +
-- encerramento), abandono sem o aviso de 30 dias (2 meses de honorários do
-- atendimento) e falta injustificada (2x por unidade). Vale para termos
-- montados daqui em diante: o texto só é remontado antes da 1ª assinatura,
-- então termo já assinado continua no modelo em que foi assinado.
insert into private.teacher_student_term_templates(version,body) values(2,$term_v2$# Termo individual de prestação de aulas - versão 2

Instrumento prospectivo entre escola e prestador, em benefício do aluno identificado. Os dados das partes, a agenda, a vigência, a remuneração e as referências são preenchidos pelo servidor e integram a via apresentada às partes. O aluno mantém seu contrato com a escola; a confirmação da família é um registro separado e não assina o contrato profissional.

## 1. Objeto e livre assunção

A escola propõe e o prestador, por seu representante identificado, pode aceitar ou recusar o atendimento descrito no quadro individual. A assunção depende da manifestação expressa da escola e da assinatura do próprio prestador sobre esta versão integral. Silêncio, acesso ao portal, recebimento de convite ou contrato geral não substituem esse aceite. A confirmação do vínculo exige também disponibilidade e conclusão da atribuição no fluxo oficial. Em oferta a mais de um prestador, a assinatura não garante escolha: somente o atendimento efetivamente atribuído será executado e remunerado. Uma proposta pendente não confirma a aula.

O prestador declara que os dados de sua empresa e representante são verdadeiros e que tem poderes para representá-la. Este instrumento rege o serviço futuro aqui individualizado. Não transfere obrigações de pessoa física para pessoa jurídica, não nova contratos anteriores e não cria assinatura, dívida ou penalidade retroativa. O contrato geral efetivamente firmado mantém as condições compatíveis e seus próprios signatários.

## 2. Agenda, autonomia e continuidade

O prestador confere sua disponibilidade antes de assinar e assume os dias, horários, duração e vigência expressamente descritos. Utiliza a sala oficial da ocorrência e mantém registros verdadeiros da execução e da continuidade pedagógica. A condução técnica observa sua autonomia profissional e as condições legitimamente acordadas; não há obrigação de aceitar novas propostas, exclusividade ou disponibilidade geral permanente. A relação jurídica depende da realidade da prestação, sem garantia contratual de inexistência de emprego.

Mudança de professor, dia, horário ou duração exige o fluxo oficial e novo aceite das condições alteradas. Cobertura fica limitada às datas descritas. A escola obtém a confirmação pertinente da agenda pela família; o prestador não pode alterá-la unilateralmente. A falta de resposta do aluno não confirma prestação, satisfação ou renúncia a reclamação. Problema de acesso ou relatório incompleto exige conferência, sem conclusão automática de culpa.

## 3. Comunicação e solução de ocorrências

Impedimento previsível será comunicado à escola imediatamente após conhecido e, sempre que possível, com 24 horas de antecedência. Impedimento superveniente será comunicado tão logo possível. A escola organiza cobertura, reposição ou transição e apresenta retorno com proposta de solução em até um dia útil após conhecer a ocorrência, ressalvada apuração justificada que será informada à família. Esse prazo não promete horário ainda não aceito.

Aula não prestada por impedimento do prestador será tratada separadamente de falta do aluno e não consumirá sua franquia de reposições por ausência própria. O prestador colaborará com a informação pedagógica necessária e registrará a execução ou divergência até o fim do dia útil seguinte, sem lançamento fictício. Alegações de saúde serão tratadas com minimização de dados.

## 4. Remuneração reservada

O quadro remuneratório integra esta via entre escola e prestador e não é exibido à família. O valor de referência é o informado para a duração da ocorrência; unidades de 30 minutos e eventuais bonificações contratadas são discriminadas. A apuração financeira continua pela régua e pelos pisos validamente aplicáveis. Não se reduz remuneração anterior por este termo nem se garante bônus condicionado fora de suas condições. O aluno não contrata financeiramente o prestador e não paga valor adicional por este instrumento.

## 5. Descumprimento, multas e manifestação

O prestador é quem executa o atendimento: a escola aproxima aluno e prestador, organiza a agenda e responde ao aluno pelo serviço, e o prestador responde perante a escola pelo cumprimento pessoal do que assumiu neste termo. Ausência injustificada, interrupção injustificada, alteração unilateral, abandono sem a transição deste termo e registro de aula não prestada serão apurados individualmente. A escola comunicará reservadamente os fatos, as provas, a cláusula e o cálculo proposto. O prestador terá cinco dias úteis do recebimento comprovado para apresentar manifestação, com prorrogação razoável justificada. A direção decidirá fundamentadamente e comunicará a conclusão.

5.1 Registro de aula não prestada. Lançar, confirmar ou cobrar como dada uma aula que não aconteceu é falta grave. Comprovado o fato, o prestador: (a) devolve integralmente o que tiver recebido por essas ocorrências; (b) paga multa equivalente a dez vezes o valor de referência de cada unidade de 30 minutos registrada sem ter sido prestada; e (c) tem encerrados, de imediato, este e os demais atendimentos que mantém com a escola, sem bônus de transição. O registro falso pode configurar ilícito penal, e a escola poderá levar os fatos às autoridades competentes. Engano de lançamento corrigido pelo próprio prestador antes de qualquer pagamento ou apuração não caracteriza esta hipótese.

5.2 Abandono do atendimento. Deixar o aluno sem cumprir o aviso de 30 dias da cláusula 6, inclusive comunicando que não dará mais as aulas e parando antes do fim do prazo, sujeita o prestador a multa fixa equivalente a dois meses de honorários deste atendimento: a média mensal dos honorários das aulas deste aluno nos três últimos meses completos ou, sem esse histórico, o valor de referência multiplicado pelas unidades semanais da agenda deste termo e por 8,6 semanas. Quando comprovado, soma-se a diferença que a escola tiver de pagar a mais a um substituto para cobrir as aulas do período não cumprido. Esta multa substitui, para este aluno, a cláusula penal de saída do contrato geral, sem acumulação pelo mesmo fato.

5.3 Falta injustificada. Para ausência injustificada em ocorrência assumida após as assinaturas, a multa equivale a duas vezes o valor de referência de cada unidade de 30 minutos não prestada. A base é sempre o honorário da ocorrência e nunca a mensalidade do aluno.

5.4 Regras comuns. As multas se aplicam somente ao descumprimento efetivamente demonstrado, após a manifestação do prestador. Caso fortuito, força maior, problema de saúde comunicado e fatos não imputáveis ao prestador não geram multa. A aula não prestada, por si, não gera remuneração; isso não equivale à multa. Não há desconto automático, retenção global de repasse, saldo negativo ou cobrança automática no Asaas do prestador: valores reconhecidos podem ser compensados por acordo escrito ou cobrados pelos meios legais. Prejuízo suplementar exige prova do excedente, do nexo causal e do cabimento legal, sem duplicidade com multa. Acordo comercial da escola com aluno não torna o prestador automaticamente devedor.

## 6. Saída e transição

O prestador pode comunicar por escrito a saída deste atendimento com aviso de 30 dias corridos, contado do dia seguinte ao recebimento comprovado no canal oficial. Durante o aviso continua dando as aulas assumidas, com remuneração normal. A transição termina na data final acordada; não depende de achar substituto nem exige novas propostas ou trabalho gratuito. Redução ou dispensa do prazo só vale por acordo escrito com a escola, e motivo justificado de saída antecipada (saúde, força maior, risco à segurança) será examinado individualmente, sem multa quando comprovado. Cobertura pontual termina nas ocorrências expressamente descritas. A saída do prestador não cancela, por si, o contrato do aluno.

## 7. Provas, dados e assinatura

As partes aceitam a manifestação eletrônica autenticada, vinculada ao texto integral, identificador, versão, resumo SHA-256, nome digitado, autoria e data do servidor. A assinatura de uma parte não será atribuída à outra. Cada parte pode consultar e baixar sua via e seus comprovantes. Depois da primeira assinatura, alteração do conteúdo exige nova versão e novos aceites, preservando a via anterior.

A escola trata os dados necessários à contratação, execução, continuidade e exercício regular de direitos, com acesso restrito. Este termo não cria autorização de gravação e preserva as regras de privacidade e recusa aplicáveis às aulas. Os registros técnicos serão apreciados junto com o contexto e a manifestação dos envolvidos. A confirmação da agenda pela família não revela remuneração nem implica quitação ou renúncia. A escola permanece responsável pelo serviço perante o aluno e não condiciona a solução da reclamação ao recebimento de valores do prestador.
$term_v2$) on conflict(version) do nothing;

do $patch$
declare s text;
begin
 s:=pg_get_functiondef('private.student_term_render(private.teacher_student_terms)'::regprocedure);
 if strpos(s,'v_model')=0 then
  if strpos(s,'select body into v from private.teacher_student_term_templates where version=1;')=0 or strpos(s,'Modelo jurídico: 1')=0 then raise exception 'term_render_template_anchor_changed';end if;
  s:=replace(s,'declare v text;','declare v text;v_model integer;');
  s:=replace(s,'select body into v from private.teacher_student_term_templates where version=1;','select body,version into v,v_model from private.teacher_student_term_templates order by version desc limit 1;');
  s:=replace(s,$a$E'\nModelo jurídico: 1\n\nESCOLA: '$a$,$a$E'\nModelo jurídico: '||v_model||E'\n\nESCOLA: '$a$);
  if strpos(s,'Modelo jurídico: 1')>0 then raise exception 'term_render_model_label_anchor_changed';end if;
  execute s;
 end if;
end;$patch$;

-- Agenda legível: "Terça 19:00 (1h) · Quinta 19:00 (1h)" ou com data.
create or replace function private.student_term_agenda_text(p_slots jsonb)
returns text language sql immutable set search_path='' as $$
 select coalesce(string_agg(label,' · ' order by ord),'')
 from(
  select min(ord) ord,
   coalesce(to_char(d::date,'DD/MM'),(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[wd+1])
    ||' '||min(t)||case when count(*)>1 then ' ('||case when count(*)%2=0 then (count(*)/2)::text||'h' else (count(*)*30)::text||' min' end||')' else ' (30 min)' end label
  from(select (s->>'day')::int wd,s->>'time' t,nullif(s->>'date','') d,o ord from jsonb_array_elements(p_slots) with ordinality x(s,o)) z
  group by wd,d) g;
$$;

-- Quem assina pela escola: diretor ativo, preferindo quem já assinou termos.
create or replace function private.student_term_school_signer(p_tenant text)
returns uuid language sql stable security definer set search_path='' as $$
 select m.user_id from public.tenant_memberships m join public.profiles p on p.id=m.user_id
 where m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='SCHOOL_ADMIN'
  and lower(coalesce(p.lifecycle_status,'active'))='active' and private.whatsapp_digits(nullif(p.phone,'')) is not null
 order by (select count(*) from private.teacher_student_terms t where t.school_signed_by=m.user_id) desc,m.created_at
 limit 1;
$$;

-- Gera o link pessoal e põe a mensagem na fila oficial (instância central).
-- Só o hash do token fica no banco. Link anterior em aberto da mesma parte é
-- revogado: vale sempre o último que chegou.
create or replace function private.student_term_issue_link(p_term uuid,p_signer text,p_reminder boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;v_signer uuid;v_phone text;v_token text;v_url text;v_msg text;v_first text;v_n int;v_name text;
begin
 select * into r from private.teacher_student_terms where id=p_term;
 if r.id is null or r.status<>'PROPOSED' or r.retired_at is not null then return false;end if;
 if p_signer='TEACHER' then
  if r.teacher_signed_at is not null or not public.teacher_opportunity_recipient_eligible(r.tenant_id,r.teacher_id) then return false;end if;
  v_signer:=r.teacher_id;
 elsif p_signer='SCHOOL' then
  if r.school_signed_at is not null or r.provider_identity is null then return false;end if;
  v_signer:=private.student_term_school_signer(r.tenant_id);
 else return false;end if;
 select private.whatsapp_digits(nullif(p.phone,'')),p.full_name into v_phone,v_name from public.profiles p where p.id=v_signer;
 v_url:=private.lesson_recording_portal_url(r.tenant_id);
 if v_signer is null or v_phone is null or v_url is null then return false;end if;
 update private.student_term_links set revoked_at=clock_timestamp() where term_id=r.id and signer=p_signer and used_at is null and revoked_at is null;
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.student_term_links(token_hash,term_id,signer,signer_id,phone,expires_at,reminded_at)
 values(encode(extensions.digest(v_token,'sha256'),'hex'),r.id,p_signer,v_signer,v_phone,now()+interval '7 days',case when p_reminder then clock_timestamp() end);
 select count(*) into v_n from private.student_term_links where term_id=r.id and signer=p_signer;
 v_url:=v_url||'/aceitar-termo?t='||v_token;
 v_first:=split_part(btrim(v_name),' ',1);
 if p_signer='TEACHER' then
  v_msg:=format(E'%sOi, %s! 🐺 Aluno novo para você: *%s*\n📅 %s, a partir de %s.\n\nAo aceitar, você assume este aluno nesses horários (o termo traz as regras de falta e de saída). Toque no link, confira e assine (leva 1 minuto):\n%s\n\nSe não puder atender, é só tocar em "Não posso atender" na mesma página.',
   case when p_reminder then E'⏰ Lembrete: ' else '' end,v_first,r.student_name,private.student_term_agenda_text(r.slots),to_char(r.starts_on,'DD/MM'),v_url);
 else
  v_msg:=format(E'%s📝 Termo do aluno *%s* com %s para a escola assinar.\n📅 %s, a partir de %s.\n\nAssine por aqui:\n%s',
   case when p_reminder then E'⏰ Lembrete: ' else '' end,r.student_name,r.teacher_name,private.student_term_agenda_text(r.slots),to_char(r.starts_on,'DD/MM'),v_url);
 end if;
 insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,source_type,notification_kind,idempotency_key)
 values(r.tenant_id,case when p_signer='TEACHER' then r.teacher_id else v_signer end,r.student_id,v_name,v_phone,v_msg,now(),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term-link:%s:%s:%s',r.id,lower(p_signer),v_n))
 on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
 return true;
end;$$;

-- Aviso: a proposta nasce → link para o professor e, com os dados do
-- prestador já preenchidos, link para a escola. Falha no aviso nunca derruba
-- a proposta. Substitui o aviso antigo "abra o portal".
create or replace function private.student_term_notify()
returns trigger language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;
begin
 if new.event<>'PROPOSED' then return new;end if;
 select * into r from private.teacher_student_terms where id=new.term_id;
 if r.id is null or r.status<>'PROPOSED' then return new;end if;
 begin
  perform private.student_term_issue_link(r.id,'TEACHER');
  perform private.student_term_issue_link(r.id,'SCHOOL');
 exception when others then
  raise warning '[termo individual] link não enfileirado para %: %',r.id,sqlerrm;
 end;
 return new;
end;$$;
drop trigger if exists zz_student_term_notify on private.teacher_student_term_events;
create trigger zz_student_term_notify after insert on private.teacher_student_term_events for each row execute function private.student_term_notify();

-- Dados do prestador entraram no termo (pelo link ou pelo portal): agora a
-- escola já pode assinar, então o link dela sai.
create or replace function private.student_term_identity_filled()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.provider_identity is null and new.provider_identity is not null and new.status='PROPOSED' and new.school_signed_at is null
  and not exists(select 1 from private.student_term_links where term_id=new.id and signer='SCHOOL' and used_at is null and revoked_at is null and expires_at>now()) then
  begin perform private.student_term_issue_link(new.id,'SCHOOL');
  exception when others then raise warning '[termo individual] link da escola não enfileirado para %: %',new.id,sqlerrm;end;
 end if;
 return null;
end;$$;
drop trigger if exists zz_student_term_identity_filled on private.teacher_student_terms;
create trigger zz_student_term_identity_filled after update of provider_identity on private.teacher_student_terms for each row execute function private.student_term_identity_filled();

-- Link aberto e válido → linha do link + termo (travado), ou nada.
create or replace function private.student_term_link_open(p_token text)
returns private.student_term_links language plpgsql security definer set search_path='' as $$
declare l private.student_term_links;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null;end if;
 select * into l from private.student_term_links where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
 if l.token_hash is null or l.used_at is not null or l.revoked_at is not null or l.expires_at<now() then return null;end if;
 return l;
end;$$;

-- Leitura pela página pública. Sem token válido não diz nada além do motivo.
create or replace function public.student_term_link_view(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l private.student_term_links;r private.teacher_student_terms;v_name text;v_school text;v_identity jsonb;
begin
 l:=private.student_term_link_open(p_token);
 if l.token_hash is null then
  select * into l from private.student_term_links where p_token ~ '^[0-9a-f]{64}$' and token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  return jsonb_build_object('ok',false,'reason',case when l.token_hash is null then 'invalid' when l.used_at is not null then 'used' when l.revoked_at is not null then 'replaced' else 'expired' end);
 end if;
 select * into r from private.teacher_student_terms where id=l.term_id;
 if r.status<>'PROPOSED' then return jsonb_build_object('ok',false,'reason',lower(r.status));end if;
 if (l.signer='TEACHER' and r.teacher_signed_at is not null) or (l.signer='SCHOOL' and r.school_signed_at is not null) then return jsonb_build_object('ok',false,'reason','used');end if;
 update private.student_term_links set opened_at=coalesce(opened_at,clock_timestamp()) where token_hash=l.token_hash;
 select full_name into v_name from public.profiles where id=l.signer_id;
 v_school:=coalesce(r.school_snapshot->>'legalName',r.school_snapshot->>'name',r.tenant_id);
 if l.signer='TEACHER' then select i.identity into v_identity from private.teacher_service_identities i where i.tenant_id=r.tenant_id and i.teacher_id=r.teacher_id;end if;
 return jsonb_build_object('ok',true,'signer',l.signer,'signer_name',v_name,'school_name',v_school,
  'student_name',r.student_name,'teacher_name',r.teacher_name,'agenda',private.student_term_agenda_text(r.slots),
  'starts_on',r.starts_on,'ends_on',r.ends_on,'unit_rate',r.unit_rate,
  'needs_identity',r.provider_identity is null,'identity_on_file',v_identity is not null,
  'other_signed',case when l.signer='TEACHER' then r.school_signed_at is not null else r.teacher_signed_at is not null end,
  'body',r.body,'content_hash',r.content_hash,'term_id',r.id,'version',r.version,'expires_at',l.expires_at);
end;$$;

-- Ação pela página: dados do prestador, assinar ou recusar. Age como quem
-- recebeu o link pela mesma RPC do portal (mesmas validações e eventos), e
-- registra o meio (link do WhatsApp, IP e navegador) num evento à parte.
create or replace function public.student_term_link_act(p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare l private.student_term_links;r private.teacher_student_terms;v_result jsonb;h jsonb;v_ip text;v_ua text;
begin
 if p_action not in('identity','sign','decline') then return jsonb_build_object('ok',false,'error','acao_invalida');end if;
 l:=private.student_term_link_open(p_token);
 if l.token_hash is null then return jsonb_build_object('ok',false,'error','link_invalido');end if;
 if p_action in('identity','decline') and l.signer<>'TEACHER' then return jsonb_build_object('ok',false,'error','acao_invalida');end if;
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 v_ip:=left(btrim(split_part(coalesce(h->>'x-real-ip',h->>'cf-connecting-ip',h->>'x-forwarded-for',''),',',1)),64);
 v_ua:=left(coalesce(h->>'user-agent',''),300);
 perform private.trial_closing_act_as(l.signer_id);
 begin
  v_result:=public.teacher_student_terms(p_action,case when p_action='identity' then null else l.term_id end,
   case when p_action='sign' then jsonb_build_object('typed_name',p_payload->>'typed_name','content_hash',p_payload->>'content_hash','accepted',p_payload->'accepted','has_authority',p_payload->'has_authority') else coalesce(p_payload,'{}') end);
 exception when others then
  perform private.trial_closing_act_as(null);
  return jsonb_build_object('ok',false,'error',sqlerrm);
 end;
 perform private.trial_closing_act_as(null);
 select * into r from private.teacher_student_terms where id=l.term_id;
 if p_action='identity' then
  -- O link da escola sai pelo gatilho de dados preenchidos (abaixo).
  return jsonb_build_object('ok',true);
 end if;
 update private.student_term_links set used_at=clock_timestamp() where token_hash=l.token_hash;
 insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash,details)
 values(r.id,l.signer_id,case when p_action='sign' then 'SIGNED_VIA_WHATSAPP_LINK' else 'DECLINED_VIA_WHATSAPP_LINK' end,r.content_hash,
  jsonb_build_object('signer',l.signer,'phone',l.phone,'ip',nullif(v_ip,''),'user_agent',nullif(v_ua,''),'link_created_at',l.created_at));
 return jsonb_build_object('ok',true,'phase',private.student_term_phase(r),'status',r.status);
end;$$;

-- Lembrete: link aberto há 24 h sem assinatura → um lembrete (link novo). Termo
-- parado há 48 h → aviso à coordenação, uma vez. Só entre 9h e 21h (Brasília).
create or replace function private.student_term_link_reminders()
returns jsonb language plpgsql security definer set search_path='' as $$
declare l record;v_dest text;n_rem int:=0;n_stale int:=0;h int:=extract(hour from now() at time zone 'America/Sao_Paulo');
begin
 if h<9 or h>=21 then return jsonb_build_object('ok',true,'skipped','fora_do_horario');end if;
 for l in select k.term_id,k.signer from private.student_term_links k join private.teacher_student_terms t on t.id=k.term_id
  where k.used_at is null and k.revoked_at is null and k.reminded_at is null and k.created_at<now()-interval '24 hours' and t.status='PROPOSED'
   and not exists(select 1 from private.student_term_links o where o.term_id=k.term_id and o.signer=k.signer and o.reminded_at is not null)
 loop
  begin if private.student_term_issue_link(l.term_id,l.signer,true) then n_rem:=n_rem+1;end if;
  exception when others then raise warning '[termo individual] lembrete falhou para %: %',l.term_id,sqlerrm;end;
 end loop;
 for l in select t.* from private.teacher_student_terms t where t.status='PROPOSED' and t.retired_at is null and t.created_at<now()-interval '48 hours'
  and exists(select 1 from private.student_term_links k where k.term_id=t.id) loop
  begin
   v_dest:=private.tenant_notice_destination(l.tenant_id,'coordenacao');
   if v_dest is null then continue;end if;
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,source_type,notification_kind,idempotency_key)
   values(l.tenant_id,l.teacher_id,l.student_id,'Coordenação',v_dest,
    format(E'⏳ Termo do aluno %s com %s parado há mais de 2 dias.\nFalta: %s.\nO aluno não começa enquanto isso não for assinado.',l.student_name,l.teacher_name,
     concat_ws(' e ',case when l.school_signed_at is null then 'assinatura da escola' end,case when l.teacher_signed_at is null then 'assinatura de '||split_part(l.teacher_name,' ',1) end,case when l.family_confirmed_at is null then 'confirmação da agenda pela família' end)),
    now(),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term:%s:stale',l.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
   if found then n_stale:=n_stale+1;end if;
  exception when others then raise warning '[termo individual] aviso de termo parado falhou para %: %',l.id,sqlerrm;end;
 end loop;
 return jsonb_build_object('ok',true,'reminders',n_rem,'stale',n_stale);
end;$$;

-- Envio pontual pela plataforma (termos que já existiam antes do link).
create or replace function public.student_term_send_links(p_term uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;tenant text:=private.active_tenant_id(auth.uid());role_name text:=private.active_tenant_role(auth.uid());t boolean;s boolean;
begin
 if auth.uid() is null or coalesce(role_name,'') not in('SCHOOL_ADMIN','COORDINATOR') then raise exception 'not_authorized' using errcode='42501';end if;
 select * into r from private.teacher_student_terms where id=p_term and tenant_id=tenant;
 if r.id is null or r.status<>'PROPOSED' then return jsonb_build_object('ok',false,'error','termo_indisponivel');end if;
 t:=private.student_term_issue_link(r.id,'TEACHER');
 s:=private.student_term_issue_link(r.id,'SCHOOL');
 return jsonb_build_object('ok',t or s,'teacher',t,'school',s);
end;$$;

do $$declare r record;begin
 for r in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and p.proname in('student_term_agenda_text','student_term_school_signer','student_term_issue_link','student_term_notify','student_term_identity_filled','student_term_link_open','student_term_link_reminders'))
   or (n.nspname='public' and p.proname in('student_term_link_view','student_term_link_act','student_term_send_links','teacher_student_terms')) loop
  execute format('alter function %s owner to postgres',r.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end$$;
grant execute on function public.student_term_link_view(text) to anon,authenticated;
grant execute on function public.student_term_link_act(text,text,jsonb) to anon,authenticated;
grant execute on function public.student_term_send_links(uuid) to authenticated;
grant execute on function public.teacher_student_terms(text,uuid,jsonb) to authenticated;

do $$begin
 if exists(select 1 from cron.job where jobname='wisewolf-student-term-link-reminders') then perform cron.unschedule('wisewolf-student-term-link-reminders');end if;
 perform cron.schedule('wisewolf-student-term-link-reminders','17 * * * *','select private.student_term_link_reminders()');
end$$;
