-- Aceites individuais prospectivos; contratos e assinaturas anteriores permanecem íntegros.
create table if not exists private.teacher_student_term_policy(
 tenant_id text primary key references public.tenants(id),enabled boolean not null default false,starts_at timestamptz not null default now());
create table if not exists private.teacher_student_term_legacy_offers(
 offer_id uuid primary key references public.offers(id),tenant_id text not null,student_id uuid not null,recorded_at timestamptz not null default now());
create table if not exists private.teacher_student_term_legacy_transfers(transfer_id uuid primary key references public.teacher_transfers(id),tenant_id text not null,student_id uuid not null,teacher_id uuid not null,cutover_date date not null,slots jsonb not null,recorded_at timestamptz not null default now());
create table if not exists private.teacher_service_identities(
 tenant_id text not null,teacher_id uuid not null references public.profiles(id),identity jsonb not null,confirmed_at timestamptz not null default now(),primary key(tenant_id,teacher_id));
create table if not exists private.teacher_student_terms(
 id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),student_id uuid not null references public.profiles(id),teacher_id uuid not null references public.profiles(id),
 source_kind text not null check(source_kind in('ENROLLMENT','MANUAL','COVERAGE','SCHEDULE_CHANGE','TRANSFER','COVERAGE_OPPORTUNITY')),source_id uuid not null,source_key text not null,source_hash text not null,
 version integer not null default 1,mode text not null check(mode in('RECURRING','DATED')),starts_on date not null,ends_on date,slots jsonb not null,unit_rate numeric not null check(unit_rate>0),
 school_snapshot jsonb not null,student_name text not null,teacher_name text not null,provider_identity jsonb,body text not null default '',content_hash text not null default '',
 status text not null default 'PROPOSED' check(status in('PROPOSED','EXECUTED','DECLINED','REVOKED','SUPERSEDED','TERMINATED')),
 school_signed_by uuid,school_signed_at timestamptz,school_typed_name text,teacher_signed_by uuid,teacher_signed_at timestamptz,teacher_typed_name text,
 family_confirmation jsonb,family_confirmed_at timestamptz,retired_at timestamptz,closed_reason text,created_by uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(tenant_id,source_key,version),check(ends_on is null or ends_on>=starts_on),check((school_signed_at is null)=(school_signed_by is null)),check((teacher_signed_at is null)=(teacher_signed_by is null)));
create unique index if not exists teacher_student_terms_active_source on private.teacher_student_terms(tenant_id,source_key) where status in('PROPOSED','EXECUTED');
create index if not exists teacher_student_terms_teacher on private.teacher_student_terms(teacher_id,created_at desc);
create index if not exists teacher_student_terms_student on private.teacher_student_terms(student_id,created_at desc);
create index if not exists teacher_student_terms_school on private.teacher_student_terms(tenant_id,created_at desc);
create table if not exists private.teacher_student_term_events(
 id uuid primary key default gen_random_uuid(),term_id uuid not null references private.teacher_student_terms(id),actor_id uuid,event text not null,content_hash text not null,details jsonb not null default '{}',created_at timestamptz not null default clock_timestamp());
create index if not exists teacher_student_term_events_term on private.teacher_student_term_events(term_id,created_at);
create table if not exists private.teacher_student_term_bindings(
 entity_table text not null,entity_id uuid not null,term_id uuid not null references private.teacher_student_terms(id),created_at timestamptz not null default now(),ended_at timestamptz,primary key(entity_table,entity_id,term_id));
create unique index if not exists teacher_student_term_binding_current on private.teacher_student_term_bindings(entity_table,entity_id) where ended_at is null;
create index if not exists teacher_student_term_bindings_term on private.teacher_student_term_bindings(term_id) where ended_at is null;
create table if not exists private.teacher_student_term_templates(version integer primary key,body text not null);
do $$declare n text;begin foreach n in array array['teacher_student_term_policy','teacher_student_term_legacy_offers','teacher_student_term_legacy_transfers','teacher_service_identities','teacher_student_terms','teacher_student_term_events','teacher_student_term_bindings','teacher_student_term_templates'] loop
 execute format('alter table private.%I owner to postgres',n);execute format('alter table private.%I enable row level security',n);execute format('revoke all on private.%I from public,anon,authenticated,service_role',n);end loop;end$$;

insert into private.teacher_student_term_templates(version,body) values(1,$term_v1$# Termo individual de prestação de aulas - versão 1

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

## 5. Descumprimento e manifestação

Ausência injustificada, interrupção injustificada, alteração unilateral, abandono sem transição cabível ou registro de serviço não prestado serão apurados individualmente. A escola comunicará reservadamente os fatos, provas, cláusula e cálculo propostos. O prestador terá cinco dias úteis do recebimento comprovado para apresentar manifestação, com prorrogação razoável justificada. A direção decidirá fundamentadamente e comunicará a conclusão.

Para ausência injustificada em ocorrência assumida após as assinaturas, convenciona-se multa equivalente a uma remuneração contratual da parcela não prestada, limitada e proporcional ao descumprimento efetivamente demonstrado. A base é o honorário da ocorrência e não a mensalidade do aluno. Cumprimento parcial, excesso, caso fortuito, força maior e fatos não imputáveis recebem o tratamento legal cabível. Não há multiplicador automático por reincidência.

A aula não prestada, por si, não gera remuneração; isso não equivale à cobrança da multa. Remuneração incontroversa por serviço prestado permanece separada da apuração. Não há desconto automático, retenção global de repasse, saldo negativo ou cobrança automática no Asaas do prestador. Prejuízo suplementar exige prova do excedente, do nexo causal e do cabimento legal, sem duplicidade com multa, economia de custo ou valores recuperados. Acordo comercial da escola com aluno não torna o prestador automaticamente devedor.

## 6. Saída e transição

O prestador pode comunicar por escrito a saída dos atendimentos recorrentes, com aviso bilateral pactuado de 30 dias corridos, contado do dia seguinte ao recebimento comprovado. O prazo é contratual, não mínimo legal universal. Redução ou dispensa por acordo e motivo justificado de saída antecipada serão examinados individualmente. A transição abrange somente atendimentos já assumidos, com remuneração normal, e termina na data final acordada; não depende de achar substituto nem exige novas propostas ou trabalho gratuito. Cobertura pontual termina nas ocorrências expressamente descritas. A saída do prestador não cancela, por si, o contrato do aluno.

## 7. Provas, dados e assinatura

As partes aceitam a manifestação eletrônica autenticada, vinculada ao texto integral, identificador, versão, resumo SHA-256, nome digitado, autoria e data do servidor. A assinatura de uma parte não será atribuída à outra. Cada parte pode consultar e baixar sua via e seus comprovantes. Depois da primeira assinatura, alteração do conteúdo exige nova versão e novos aceites, preservando a via anterior.

A escola trata os dados necessários à contratação, execução, continuidade e exercício regular de direitos, com acesso restrito. Este termo não cria autorização de gravação e preserva as regras de privacidade e recusa aplicáveis às aulas. Os registros técnicos serão apreciados junto com o contexto e a manifestação dos envolvidos. A confirmação da agenda pela família não revela remuneração nem implica quitação ou renúncia. A escola permanece responsável pelo serviço perante o aluno e não condiciona a solução da reclamação ao recebimento de valores do prestador.
$term_v1$) on conflict(version) do nothing;

create or replace function private.student_term_required(p_tenant text,p_offer uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.teacher_student_term_policy where tenant_id=p_tenant and enabled)
 and not exists(select 1 from private.teacher_student_term_legacy_offers where offer_id=p_offer and tenant_id=p_tenant);
$$;
create or replace function private.student_term_slots(p_slots jsonb,p_mode text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare r jsonb;v jsonb:='[]';d integer;t text;dt date;
begin
 if jsonb_typeof(p_slots) is distinct from 'array' or jsonb_array_length(p_slots) not between 1 and 30 or p_mode not in('RECURRING','DATED') then raise exception 'term_agenda_invalid';end if;
 for r in select value from jsonb_array_elements(p_slots) loop
  t:=left(coalesce(r->>'time',r->>'time_slot',''),5);d:=coalesce(nullif(r->>'day','')::integer,public.dow_name_to_int(coalesce(r->>'day_of_week',r->>'weekday')));
  if p_mode='DATED' then dt:=(r->>'date')::date;d:=extract(dow from dt)::integer;else dt:=null;end if;
  if t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or d not between 0 and 6 or d is null or(p_mode='DATED' and dt is null) then raise exception 'term_agenda_invalid';end if;
  v:=v||jsonb_build_array(jsonb_build_object('day',d,'time',t,'date',dt));
 end loop;
 return(select jsonb_agg(q.x order by q.x->>'date',(q.x->>'day')::int,q.x->>'time') from(select distinct value x from jsonb_array_elements(v)) q);
end;$$;
create or replace function private.student_term_phase(p private.teacher_student_terms)
returns text language sql immutable set search_path='' as $$
 select case when p.status<>'PROPOSED' then p.status when p.provider_identity is null then 'IDENTITY_PENDING' when p.school_signed_at is null then 'SCHOOL_PENDING' when p.teacher_signed_at is null then 'TEACHER_PENDING' when p.family_confirmed_at is null then 'FAMILY_PENDING' else 'EXECUTED' end;
$$;
create or replace function private.student_term_render(p private.teacher_student_terms)
returns text language plpgsql stable security definer set search_path='' as $$
declare v text;agenda text;general_ref text;
begin
 select string_agg(case when p.mode='DATED' then to_char((x->>'date')::date,'DD/MM/YYYY') else(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[(x->>'day')::int+1] end||' às '||(x->>'time')||' - unidade de 30 minutos',E'\n' order by x->>'date',(x->>'day')::int,x->>'time') into agenda from jsonb_array_elements(p.slots) x;
 select body into v from private.teacher_student_term_templates where version=1;
 select 'Registro '||id||' | versão '||coalesce(commercial_snapshot->>'contractTermsVersion','legada')||' | aceito em '||accepted_at::text into general_ref from public.tenant_contract_records where tenant_id=p.tenant_id and user_id=p.teacher_id and contract_kind='TEACHER' order by accepted_at desc limit 1;
 if general_ref is null then select 'Aceite geral legado do perfil '||id||' | data '||coalesce(accepted_at::text,'não registrada')||' | prova '||coalesce(signature_hash,'não disponível') into general_ref from public.profiles where id=p.teacher_id and contract_accepted;end if;
 return 'TERMO INDIVIDUAL DE PRESTAÇÃO DE AULAS'||E'\nReferência: '||p.id||' | revisão '||p.version||E'\nModelo jurídico: 1\n\nESCOLA: '||(p.school_snapshot->>'legalName')||' | CNPJ '||(p.school_snapshot->>'cnpj')||E'\nEndereço: '||(p.school_snapshot->>'address')||E'\nCanal: '||(p.school_snapshot->>'email')||E'\n\nPRESTADOR: '||coalesce(p.provider_identity->>'companyName','Dados da empresa pendentes')||' | CNPJ '||coalesce(p.provider_identity->>'cnpj','pendente')||E'\nEndereço: '||coalesce(p.provider_identity->>'companyAddress','pendente')||E'\nRepresentante: '||p.teacher_name||' | CPF '||coalesce(p.provider_identity->>'representativeCpf','pendente')||E'\n\nALUNO BENEFICIÁRIO: '||p.student_name||' | referência interna '||p.student_id||E'\nVigência: '||to_char(p.starts_on,'DD/MM/YYYY')||coalesce(' até '||to_char(p.ends_on,'DD/MM/YYYY'),' até encerramento ou substituição formal do atendimento')||E'\nFuso: America/Sao_Paulo\nAgenda:\n'||agenda||E'\n\nANEXO REMUNERATÓRIO RESERVADO\nValor de referência por unidade de 30 minutos: R$ '||replace(to_char(p.unit_rate,'FM9999990.00'),'.',',')||E'.\nDuas unidades consecutivas correspondem a 60 minutos. A apuração respeita a régua e os pisos contratados; bonificação condicionada não vira garantia permanente.\nOrigem: '||p.source_kind||' / '||p.source_id||E'\n\n'||v;
end;$$;
create or replace function private.student_term_refresh(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;v text;
begin
 select * into r from private.teacher_student_terms where id=p_id for update;
 if r.school_signed_at is not null or r.teacher_signed_at is not null then return;end if;
 v:=private.student_term_render(r);
 update private.teacher_student_terms set body=v,content_hash=encode(extensions.digest(v,'sha256'),'hex'),updated_at=now() where id=r.id;
end;$$;
create or replace function private.student_term_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'term_history_preserved';end if;
 if(old.school_signed_at is not null or old.teacher_signed_at is not null) and
 (to_jsonb(new)-array['status','school_signed_by','school_signed_at','school_typed_name','teacher_signed_by','teacher_signed_at','teacher_typed_name','family_confirmation','family_confirmed_at','closed_reason','retired_at','updated_at']) is distinct from
 (to_jsonb(old)-array['status','school_signed_by','school_signed_at','school_typed_name','teacher_signed_by','teacher_signed_at','teacher_typed_name','family_confirmation','family_confirmed_at','closed_reason','retired_at','updated_at']) then raise exception 'signed_term_content_is_immutable';end if;
 if old.school_signed_at is not null and row(new.school_signed_at,new.school_signed_by,new.school_typed_name) is distinct from row(old.school_signed_at,old.school_signed_by,old.school_typed_name) then raise exception 'signature_is_immutable';end if;
 if old.teacher_signed_at is not null and row(new.teacher_signed_at,new.teacher_signed_by,new.teacher_typed_name) is distinct from row(old.teacher_signed_at,old.teacher_signed_by,old.teacher_typed_name) then raise exception 'signature_is_immutable';end if;
 return new;
end;$$;
drop trigger if exists student_term_immutable on private.teacher_student_terms;
create trigger student_term_immutable before update or delete on private.teacher_student_terms for each row execute function private.student_term_immutable();

create or replace function private.student_term_prepare(p_tenant text,p_student uuid,p_teacher uuid,p_kind text,p_source uuid,p_mode text,p_start date,p_end date,p_slots jsonb,p_family jsonb default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_slots jsonb;v_key text;v_hash text;r private.teacher_student_terms;s public.profiles;t public.profiles;school jsonb;identity jsonb;rate numeric;v uuid;
begin
 if not private.student_term_required(p_tenant,case when p_kind='ENROLLMENT' then p_source end) then return null;end if;
 if not public.teacher_opportunity_recipient_eligible(p_tenant,p_teacher) then raise exception 'term_teacher_inactive';end if;
 select * into s from public.profiles where id=p_student and tenant_id=p_tenant and role='STUDENT' and lifecycle_status='active';
 select * into t from public.profiles where id=p_teacher and tenant_id=p_tenant and role='TEACHER';
 if s.id is null or p_start is null or(p_end is not null and p_end<p_start) then raise exception 'term_party_or_general_contract_invalid';end if;
 v_slots:=private.student_term_slots(p_slots,p_mode);
 if p_mode='DATED' and exists(select 1 from jsonb_array_elements(v_slots) d where(d->>'date')::date<p_start or(p_end is not null and(d->>'date')::date>p_end)) then raise exception 'term_date_outside_scope';end if;
 school:=private.contract_school_info(p_tenant);
 select i.identity into identity from private.teacher_service_identities i where i.tenant_id=p_tenant and i.teacher_id=p_teacher;
 if identity is null then select c.party_snapshot->'providerIdentity' into identity from public.tenant_contract_records c where c.tenant_id=p_tenant and c.user_id=p_teacher and c.contract_kind='TEACHER' and c.party_snapshot?'providerIdentity' order by c.accepted_at desc limit 1;end if;
 rate:=public.teacher_student_rate(p_teacher,p_student,p_start);
 if p_kind='COVERAGE' then select coalesce(c.offered_rate,rate) into rate from public.class_coverages c where c.id=p_source;end if;
 if rate is null or rate<=0 then raise exception 'term_remuneration_missing';end if;
 v_key:=p_kind||':'||p_source||':'||p_teacher;
 v_hash:=encode(extensions.digest(jsonb_build_object('tenant',p_tenant,'student',p_student,'teacher',p_teacher,'slots',v_slots,'mode',p_mode,'start',p_start,'end',p_end)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('student-term:'||p_tenant||':'||v_key,0));
 select * into r from private.teacher_student_terms where tenant_id=p_tenant and source_key=v_key and status in('PROPOSED','EXECUTED') for update;
 if r.id is null and exists(select 1 from private.teacher_student_terms where tenant_id=p_tenant and source_key=v_key and status in('DECLINED','REVOKED')) and current_setting('app.student_term_reissue',true) is distinct from p_source::text then return null;end if;
 if r.id is not null then
  -- Mudança na fonte nunca reescreve uma via apresentada ou assinada.
  if r.source_hash=v_hash then
   if r.family_confirmed_at is null and p_family is not null then update private.teacher_student_terms set family_confirmation=p_family,family_confirmed_at=now(),status=case when school_signed_at is not null and teacher_signed_at is not null then 'EXECUTED' else status end where id=r.id;end if;
   return r.id;
  end if;
  update private.teacher_student_terms set status='SUPERSEDED',closed_reason='Fonte ou agenda alterada',updated_at=now() where id=r.id;
 end if;
 insert into private.teacher_student_terms(tenant_id,student_id,teacher_id,source_kind,source_id,source_key,source_hash,version,mode,starts_on,ends_on,slots,unit_rate,school_snapshot,student_name,teacher_name,provider_identity,created_by,family_confirmation,family_confirmed_at)
 values(p_tenant,p_student,p_teacher,p_kind,p_source,v_key,v_hash,coalesce((select max(version)+1 from private.teacher_student_terms where tenant_id=p_tenant and source_key=v_key),1),p_mode,p_start,p_end,v_slots,rate,school,s.full_name,t.full_name,identity,auth.uid(),p_family,case when p_family is not null then now() end) returning id into v;
 perform private.student_term_refresh(v);
 insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash) select id,auth.uid(),'PROPOSED',content_hash from private.teacher_student_terms where id=v;
 return v;
end;$$;

create or replace function private.student_term_enrollment(p_offer uuid,p_student uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.offers;a public.contract_terms_acceptances;slot record;v_slots jsonb;tid uuid;ready boolean:=true;v_start date;
begin
 select * into o from public.offers where id=p_offer and kind='ENROLLMENT';
 if o.id is null or o.processing_by is distinct from p_student or o.revoked_at is not null then return false;end if;
 if not private.student_term_required(o.tenant_id,o.id) then return true;end if;
 select * into a from public.contract_terms_acceptances where source='ENROLLMENT_OFFER' and source_id=o.id and user_id=p_student and contract_kind='STUDENT';
 for slot in select teacher_id,min(start_date) starts,jsonb_agg(jsonb_build_object('day',day_of_week,'time',to_char(class_time,'HH24:MI')) order by day_of_week,class_time) slots from private.enrollment_offer_schedule_slots where offer_id=o.id group by teacher_id loop
  tid:=private.student_term_prepare(o.tenant_id,p_student,slot.teacher_id,'ENROLLMENT',o.id,'RECURRING',slot.starts,null,slot.slots,case when a.id is not null then jsonb_build_object('kind','ENROLLMENT_CONTRACT','acceptance_id',a.id,'accepted_at',a.accepted_at,'terms_version',a.terms_version,'signed_as_guardian',a.signed_as_guardian) end);
  if not exists(select 1 from private.teacher_student_terms where id=tid and status='EXECUTED') then ready:=false;end if;
 end loop;
 if not found then return false;end if;
 return ready;
end;$$;
create or replace function private.student_term_source_valid(p private.teacher_student_terms)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_slots jsonb;v_start date;o public.offers;c public.class_coverages;q public.schedule_change_requests;x public.teacher_transfers;op public.coverage_opportunities;
begin
 if not exists(select 1 from public.profiles where id=p.teacher_id and contract_accepted) or not private.tenant_is_operational(p.tenant_id) or not public.teacher_opportunity_recipient_eligible(p.tenant_id,p.teacher_id)
 or not exists(select 1 from public.profiles where id=p.student_id and tenant_id=p.tenant_id and role='STUDENT' and lifecycle_status='active') then return false;end if;
 if p.source_kind='ENROLLMENT' then
  select * into o from public.offers where id=p.source_id and tenant_id=p.tenant_id and processing_by=p.student_id and revoked_at is null;
  if o.id is null or(o.consumed_at is null and o.expires_at<=now()) then return false;end if;
  if exists(select 1 from private.enrollment_offer_schedule_slots where offer_id=o.id and teacher_id=p.teacher_id and status='RESERVED' and reservation_expires_at<=now()) then return false;end if;
  select min(start_date),jsonb_agg(jsonb_build_object('day',day_of_week,'time',to_char(class_time,'HH24:MI')) order by day_of_week,class_time) into v_start,v_slots from private.enrollment_offer_schedule_slots where offer_id=o.id and teacher_id=p.teacher_id and reserved_by=p.student_id and status in('RESERVED','MATERIALIZED');
  return v_start is not distinct from p.starts_on and coalesce(private.student_term_slots(v_slots,'RECURRING')=p.slots,false);
 elsif p.source_kind='COVERAGE' then
  select * into c from public.class_coverages where id=p.source_id and tenant_id=p.tenant_id and student_id=p.student_id and cover_teacher_id=p.teacher_id and lower(status) in('pending','scheduled','confirmed','completed');
  if c.id is null or(lower(c.status) in('pending','scheduled') and coalesce(c.invite_expires_at,(c.class_date::text||' '||left(c.class_time,5)||':00-03')::timestamptz)<=now()) then return false;end if;
  return c.id is not null and exists(select 1 from jsonb_array_elements(p.slots) r where r->>'date'=c.class_date::text and r->>'time'=left(c.class_time,5));
 elsif p.source_kind='COVERAGE_OPPORTUNITY' then
  select * into op from public.coverage_opportunities where id=p.source_id and tenant_id=p.tenant_id and student_id=p.student_id and status in('OPEN','CLAIMED');
  return op.id is not null and(op.status<>'OPEN' or op.expires_at>now()) and (op.status='OPEN' or op.winner_teacher_id=p.teacher_id) and exists(select 1 from public.coverage_opportunity_invites where opportunity_id=op.id and teacher_id=p.teacher_id and status in('SENT','PENDING','ACCEPTED')) and exists(select 1 from jsonb_array_elements(p.slots) r where r->>'date'=op.class_date::text and r->>'time'=left(op.class_time,5));
 elsif p.source_kind='SCHEDULE_CHANGE' then
  select * into q from public.schedule_change_requests where id=p.source_id and tenant_id=p.tenant_id and student_id=p.student_id and teacher_id=p.teacher_id and status not in('CANCELLED','REJECTED','DECLINED','EXPIRED');
  return q.id is not null and exists(select 1 from jsonb_array_elements(p.slots) r where (r->>'day')::int=public.dow_name_to_int(q.new_day) and r->>'time'=left(q.new_time,5));
 elsif p.source_kind='TRANSFER' then
  select * into x from public.teacher_transfers where id=p.source_id and tenant_id=p.tenant_id and student_id=p.student_id and to_teacher_id=p.teacher_id and status in('PROPOSED','PENDING','ACCEPTED','APPLIED');
  return x.id is not null and x.cutover_date=p.starts_on and private.student_term_slots(x.proposed_slots,'RECURRING')=p.slots;
 end if;
 return p.source_kind='MANUAL';
exception when others then return false;
end;$$;

create or replace function private.student_term_match(p_tenant text,p_student uuid,p_teacher uuid,p_mode text,p_day integer,p_time text,p_from date,p_date date default null)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare r private.teacher_student_terms;
begin
 for r in select * from private.teacher_student_terms where tenant_id=p_tenant and student_id=p_student and teacher_id=p_teacher and status='EXECUTED' and retired_at is null and mode=p_mode and starts_on<=p_from and(ends_on is null or ends_on>=p_from) order by created_at desc for share loop
  if private.student_term_source_valid(r) and exists(select 1 from jsonb_array_elements(r.slots) s where(s->>'day')::int=p_day and s->>'time'=left(p_time,5) and(p_mode='RECURRING' or s->>'date'=p_date::text)) then return r.id;end if;
 end loop;return null;
end;$$;
create or replace function private.student_term_legacy_transfer_allows(p_tenant text,p_student uuid,p_teacher uuid,p_day integer default null,p_time text default null,p_start date default null)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.teacher_student_term_legacy_transfers l join public.teacher_transfers x on x.id=l.transfer_id
 where l.tenant_id=p_tenant and l.student_id=p_student and l.teacher_id=p_teacher and x.tenant_id=l.tenant_id and x.student_id=l.student_id and x.to_teacher_id=l.teacher_id and x.cutover_date=l.cutover_date and x.proposed_slots=l.slots and x.status in('ACCEPTED','APPLIED') and l.cutover_date<=(now() at time zone 'America/Sao_Paulo')::date and(p_start is null or p_start=l.cutover_date)
 and(p_day is null or exists(select 1 from jsonb_array_elements(l.slots) r where public.dow_name_to_int(r->>'day_of_week')=p_day and left(r->>'time_slot',5)=left(p_time,5))));
$$;

create or replace function private.guard_student_individual_term()
returns trigger language plpgsql security definer set search_path='' as $$
declare t text;sid uuid;teacher uuid;day integer;tm text;from_date date;occurrence date;mode text;oid uuid;tid uuid;b public.bookings;old_shape jsonb;new_shape jsonb;policy_start timestamptz;
begin
 t:=new.tenant_id;
 if not private.student_term_required(t,null) then return new;end if;
 if tg_table_name='bookings' then
  if upper(coalesce(new.status,'SCHEDULED'))<>'SCHEDULED' then return new;end if;
  sid:=new.student_id;teacher:=new.teacher_id;day:=public.dow_name_to_int(new.day_of_week);tm:=new.time_slot;from_date:=coalesce(new.start_date,new.date,(now() at time zone 'America/Sao_Paulo')::date);occurrence:=new.date;oid:=new.enrollment_offer_id;
  if tg_op='UPDATE' and upper(coalesce(old.status,'SCHEDULED'))='SCHEDULED' and row(new.tenant_id,new.student_id,new.teacher_id,new.day_of_week,new.time_slot,new.start_date,new.date,new.type) is not distinct from row(old.tenant_id,old.student_id,old.teacher_id,old.day_of_week,old.time_slot,old.start_date,old.date,old.type) then return new;end if;
  if not private.student_term_required(t,oid) then return new;end if;
  if tg_op='UPDATE' and row(new.day_of_week,new.time_slot) is distinct from row(old.day_of_week,old.time_slot) then select greatest(from_date,max(valid_from)) into from_date from public.booking_schedule_versions where booking_id=new.id and tenant_id=t and day_of_week=public.canonical_weekday_name(new.day_of_week) and left(time_slot,5)=left(new.time_slot,5) and valid_until is null;end if;
 elsif tg_table_name='booking_schedule_versions' then
  select * into b from public.bookings where id=new.booking_id and tenant_id=t;
  sid:=b.student_id;teacher:=b.teacher_id;day:=public.dow_name_to_int(new.day_of_week);tm:=new.time_slot;from_date:=new.valid_from;
  if tg_op='UPDATE' and row(old.booking_id,old.tenant_id,old.valid_from,old.day_of_week,old.time_slot) is not distinct from row(new.booking_id,new.tenant_id,new.valid_from,new.day_of_week,new.time_slot) and(new.valid_until is not distinct from old.valid_until or(new.valid_until is not null and(old.valid_until is null or new.valid_until<=old.valid_until))) then return new;end if;
  select starts_at into policy_start from private.teacher_student_term_policy where tenant_id=t;
  if tg_op='INSERT' and b.created_at<policy_start and new.request_id is null and day=public.dow_name_to_int(b.day_of_week) and left(tm,5)=left(b.time_slot,5) and new.valid_from=coalesce(b.start_date,(b.created_at at time zone 'America/Sao_Paulo')::date) then return new;end if;
 elsif tg_table_name='reschedules' then
  sid:=new.student_id;teacher:=new.teacher_id;occurrence:=new.date::date;day:=extract(dow from occurrence)::int;tm:=new.time;from_date:=occurrence;
  if tg_op='UPDATE' and row(new.tenant_id,new.student_id,new.teacher_id,new.date,new.time) is not distinct from row(old.tenant_id,old.student_id,old.teacher_id,old.date,old.time) then return new;end if;
 elsif tg_table_name='class_coverages' then
  if lower(coalesce(new.status,''))<>'confirmed' then return new;end if;
  select * into b from public.bookings where id=new.booking_id and tenant_id=t;
  sid:=coalesce(new.student_id,b.student_id);teacher:=new.cover_teacher_id;occurrence:=new.class_date;day:=extract(dow from occurrence)::int;tm:=new.class_time;from_date:=occurrence;
  select starts_at into policy_start from private.teacher_student_term_policy where tenant_id=t;
  if new.confirmed_by is not null and occurrence<(policy_start at time zone 'America/Sao_Paulo')::date then return new;end if;
  if tg_op='UPDATE' and lower(old.status)='confirmed' and row(new.tenant_id,new.student_id,new.cover_teacher_id,new.class_date,new.class_time,new.booking_id) is not distinct from row(old.tenant_id,old.student_id,old.cover_teacher_id,old.class_date,old.class_time,old.booking_id) then return new;end if;
 end if;
 if sid is null or teacher is null then return new;end if;
 -- Treinamento de professores não é matrícula de aluno.
 if not exists(select 1 from public.profiles where id=sid and tenant_id=t and role='STUDENT') then return new;end if;
 if tg_table_name='bookings' and occurrence is null and private.student_term_legacy_transfer_allows(t,sid,teacher,day,tm,from_date) then return new;end if;
 mode:=case when occurrence is null then 'RECURRING' else 'DATED' end;
 tid:=private.student_term_match(t,sid,teacher,mode,day,tm,from_date,occurrence);
 -- Reposição com titular pode ser coberta pela agenda recorrente já assinada,
 -- apenas se a ocorrência também estiver expressamente na grade acordada.
 if tid is null and occurrence is not null and tg_table_name='reschedules' then tid:=private.student_term_match(t,sid,teacher,'RECURRING',day,tm,from_date);end if;
 if tid is not null and tg_table_name='class_coverages' then
  if new.offered_rate is not null and not exists(select 1 from private.teacher_student_terms where id=tid and unit_rate=new.offered_rate) then tid:=null;end if;
 end if;
 if tid is null then raise exception using errcode='PT412',message='Assinatura do termo individual pendente. Abra Contratos > Termos por aluno.',detail='teacher_student_term_required';end if;
 if tg_when='AFTER' then
  with ended as(update private.teacher_student_term_bindings set ended_at=now() where entity_table=tg_table_name and entity_id=new.id and term_id<>tid and ended_at is null returning term_id) update private.teacher_student_terms set retired_at=coalesce(retired_at,now()) where id in(select term_id from ended);
  insert into private.teacher_student_term_bindings(entity_table,entity_id,term_id) values(tg_table_name,new.id,tid) on conflict(entity_table,entity_id,term_id) do nothing;
 end if;
 return new;
end;$$;
-- AFTER para gravar o vínculo somente se a linha realmente for criada. O BEFORE
-- faz a validação; a inserção privada será desfeita junto se a operação falhar.
drop trigger if exists zz_require_student_individual_term on public.bookings;
create trigger zz_require_student_individual_term before insert or update on public.bookings for each row execute function private.guard_student_individual_term();
drop trigger if exists zz_require_student_individual_term on public.booking_schedule_versions;
create trigger zz_require_student_individual_term before insert or update on public.booking_schedule_versions for each row execute function private.guard_student_individual_term();
drop trigger if exists zz_require_student_individual_term on public.reschedules;
create trigger zz_require_student_individual_term before insert or update on public.reschedules for each row execute function private.guard_student_individual_term();
drop trigger if exists zz_require_student_individual_term on public.class_coverages;
create trigger zz_require_student_individual_term before insert or update on public.class_coverages for each row execute function private.guard_student_individual_term();

create or replace function private.student_term_end_binding()
returns trigger language plpgsql security definer set search_path='' as $$
declare tid uuid;ended boolean:=false;
begin
 if tg_op='DELETE' then ended:=true;
 elsif tg_table_name='bookings' then ended:=upper(coalesce(new.status,'SCHEDULED'))<>'SCHEDULED';
 elsif tg_table_name='class_coverages' then ended:=lower(new.status) in('declined','cancelled','closed');
 elsif tg_table_name='reschedules' then ended:=new.closed_by is not null;end if;
 if ended then
  select term_id into tid from private.teacher_student_term_bindings where entity_table=tg_table_name and entity_id=old.id and ended_at is null;
  update private.teacher_student_term_bindings set ended_at=coalesce(ended_at,now()) where entity_table=tg_table_name and entity_id=old.id and ended_at is null;
  if tid is not null then update private.teacher_student_terms set retired_at=coalesce(retired_at,now()) where id=tid;end if;
  if tg_table_name='bookings' then update private.teacher_student_term_bindings set ended_at=coalesce(ended_at,now()) where entity_table='booking_schedule_versions' and entity_id in(select id from public.booking_schedule_versions where booking_id=old.id);end if;
  if tid is not null and not exists(select 1 from private.teacher_student_term_bindings where term_id=tid and ended_at is null) then update private.teacher_student_terms set status='TERMINATED',closed_reason='Atendimento encerrado no fluxo oficial',updated_at=now() where id=tid and status='EXECUTED';end if;
 end if;
 return case when tg_op='DELETE' then old else new end;
end;$$;
drop trigger if exists zz_end_student_term_binding on public.bookings;
create trigger zz_end_student_term_binding after update or delete on public.bookings for each row execute function private.student_term_end_binding();
drop trigger if exists zz_end_student_term_binding on public.class_coverages;
create trigger zz_end_student_term_binding after update or delete on public.class_coverages for each row execute function private.student_term_end_binding();
drop trigger if exists zz_end_student_term_binding on public.reschedules;
create trigger zz_end_student_term_binding after update or delete on public.reschedules for each row execute function private.student_term_end_binding();

do $$declare tab text;begin foreach tab in array array['bookings','booking_schedule_versions','reschedules','class_coverages'] loop
 execute format('drop trigger if exists zz_bind_student_individual_term on public.%I',tab);
 execute format('create trigger zz_bind_student_individual_term after insert or update on public.%I for each row execute function private.guard_student_individual_term()',tab);
end loop;end$$;

create or replace function private.student_term_source_proposal()
returns trigger language plpgsql security definer set search_path='' as $$
declare slots jsonb;tid uuid;d date;family jsonb;q public.schedule_change_requests;b public.bookings;
begin
 if not private.student_term_required(new.tenant_id,null) then return new;end if;
 if tg_table_name='offers' then
  if new.kind='ENROLLMENT' and new.processing_by is not null and new.processing_state<>'COMPLETED' and new.revoked_at is null and exists(select 1 from public.profiles where id=new.processing_by and tenant_id=new.tenant_id and role='STUDENT') then perform private.student_term_enrollment(new.id,new.processing_by);end if;
 elsif tg_table_name='class_coverages' then
  if new.cover_teacher_id is null or new.student_id is null or lower(new.status) not in('pending','scheduled') then return new;end if;
  select jsonb_agg(jsonb_build_object('date',new.class_date,'time',to_char(part_start_time,'HH24:MI'),'day',extract(dow from new.class_date)::int)) into slots from private.coverage_lesson_parts(new.id);
  -- Cobertura conserva a agenda já contratada; não é aceite de honorários pela família.
  select * into b from public.bookings where id=new.booking_id and tenant_id=new.tenant_id;
  if b.student_id=new.student_id and exists(select 1 from public.profiles where id=new.student_id and contract_accepted) then family:=jsonb_build_object('kind','EXISTING_BOOKING_UNCHANGED','booking_id',b.id,'date',new.class_date,'time',new.class_time);end if;
  tid:=private.student_term_prepare(new.tenant_id,new.student_id,new.cover_teacher_id,'COVERAGE',new.id,'DATED',new.class_date,new.class_date,slots,family);
 elsif tg_table_name='schedule_change_requests' then
  if new.status in('CANCELLED','REJECTED','DECLINED','EXPIRED') then return new;end if;
  if new.status='APPLIED' and private.student_term_match(new.tenant_id,new.student_id,new.teacher_id,case when new.scope='PERMANENT' then 'RECURRING' else 'DATED' end,public.dow_name_to_int(new.new_day),new.new_time,coalesce(new.proposed_date,new.effective_from),new.proposed_date) is not null then return new;end if;
  slots:=jsonb_build_array(jsonb_build_object('day',public.dow_name_to_int(new.new_day),'time',new.new_time,'date',new.proposed_date));
  if new.family_responded_at is not null and new.status in('ACCEPTED','APPROVED','APPLIED') then family:=jsonb_build_object('kind','SCHEDULE_CHANGE_RESPONSE','request_id',new.id,'responded_at',new.family_responded_at,'source',new.family_response_source);end if;
  tid:=private.student_term_prepare(new.tenant_id,new.student_id,new.teacher_id,'SCHEDULE_CHANGE',new.id,case when new.scope='PERMANENT' then 'RECURRING' else 'DATED' end,coalesce(new.proposed_date,new.effective_from),case when new.scope<>'PERMANENT' then new.proposed_date end,slots,family);
 elsif tg_table_name='teacher_transfers' then
  if new.status not in('PROPOSED','PENDING','ACCEPTED') then return new;end if;
  tid:=private.student_term_prepare(new.tenant_id,new.student_id,new.to_teacher_id,'TRANSFER',new.id,'RECURRING',new.cutover_date,null,new.proposed_slots,null);
 end if;
 return new;
end;$$;
drop trigger if exists zz_student_term_enrollment on public.offers;
create trigger zz_student_term_enrollment after insert or update of processing_by,payload,revoked_at on public.offers for each row execute function private.student_term_source_proposal();
drop trigger if exists zz_student_term_coverage on public.class_coverages;
create trigger zz_student_term_coverage after insert or update of cover_teacher_id,class_date,class_time on public.class_coverages for each row execute function private.student_term_source_proposal();
drop trigger if exists zz_student_term_schedule on public.schedule_change_requests;
create trigger zz_student_term_schedule after insert or update of family_responded_at,status on public.schedule_change_requests for each row execute function private.student_term_source_proposal();
drop trigger if exists zz_student_term_transfer on public.teacher_transfers;
create trigger zz_student_term_transfer after insert on public.teacher_transfers for each row execute function private.student_term_source_proposal();

create or replace function public.teacher_student_terms(p_action text default 'list',p_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();tenant text:=private.active_tenant_id(auth.uid());role_name text:=private.active_tenant_role(auth.uid());actor public.profiles;r private.teacher_student_terms;v_identity jsonb;v_id uuid;v text;v_cnpj text;v_cpf text;v_hash text;rows jsonb;is_staff boolean;is_family boolean;name text;
begin
 if uid is null or tenant is null or coalesce(role_name,'') not in('SCHOOL_ADMIN','COORDINATOR','TEACHER','STUDENT') then raise exception 'not_authorized' using errcode='42501';end if;
 select * into actor from public.profiles where id=uid;
 is_staff:=role_name in('SCHOOL_ADMIN','COORDINATOR');
 if p_action='list' then
  for v_id in select id from private.teacher_student_terms where tenant_id=tenant and status='PROPOSED' and school_signed_at is null and teacher_signed_at is null and(is_staff or teacher_id=uid) loop perform private.student_term_refresh(v_id);end loop;
  if role_name='STUDENT' then
   select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'student_name',t.student_name,'teacher_name',t.teacher_name,'mode',t.mode,'starts_on',t.starts_on,'ends_on',t.ends_on,'slots',t.slots,'status',t.status,'phase',private.student_term_phase(t),'family_confirmed_at',t.family_confirmed_at,'schedule_hash',encode(extensions.digest(jsonb_build_object('id',t.id,'slots',t.slots,'from',t.starts_on,'until',t.ends_on)::text,'sha256'),'hex')) order by t.created_at desc),'[]') into rows
   from private.teacher_student_terms t join public.profiles s on s.id=t.student_id where t.tenant_id=tenant and(s.id=uid or s.guardian_id=uid) and t.status in('PROPOSED','EXECUTED');
  else
   select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]') into rows from(select t.*,private.student_term_phase(t) phase,(select coalesce(jsonb_agg(jsonb_build_object('event',event,'actor_id',actor_id,'created_at',created_at,'content_hash',content_hash) order by created_at),'[]') from private.teacher_student_term_events where term_id=t.id) events from private.teacher_student_terms t where t.tenant_id=tenant and(is_staff or t.teacher_id=uid) order by t.created_at desc limit 200) q;
  end if;
  select i.identity into v_identity from private.teacher_service_identities i where i.tenant_id=tenant and i.teacher_id=uid;
  return jsonb_build_object('ok',true,'role',role_name,'tenant_id',tenant,'actor_name',actor.full_name,'general_contract_accepted',actor.contract_accepted,'enabled',private.student_term_required(tenant,null),'identity',v_identity,'terms',rows);
 elsif p_action='identity' then
  if role_name<>'TEACHER' or not public.teacher_opportunity_recipient_eligible(tenant,uid) then raise exception 'teacher_not_active' using errcode='42501';end if;
  v_identity:=p_payload;v_cnpj:=upper(regexp_replace(coalesce(v_identity->>'cnpj',''),'[./\s-]','','g'));v_cpf:=regexp_replace(coalesce(v_identity->>'representativeCpf',''),'[.\s-]','','g');
  if jsonb_typeof(v_identity) is distinct from 'object' or length(btrim(coalesce(v_identity->>'companyName',''))) not between 2 and 160 or length(btrim(coalesce(v_identity->>'companyAddress',''))) not between 5 and 300 or not coalesce(private.teacher_provider_cnpj_valid(v_cnpj),false) or not coalesce(public.is_valid_cpf(v_cpf),false) or v_identity->'representativeHasAuthority' is distinct from 'true'::jsonb then raise exception 'Dados da empresa inválidos ou declaração de representação ausente.';end if;
  v_identity:=jsonb_build_object('companyName',btrim(v_identity->>'companyName'),'cnpj',v_cnpj,'companyAddress',btrim(v_identity->>'companyAddress'),'representativeCpf',v_cpf,'representativeHasAuthority',true);
  insert into private.teacher_service_identities(tenant_id,teacher_id,identity) values(tenant,uid,v_identity) on conflict(tenant_id,teacher_id) do update set identity=excluded.identity,confirmed_at=now();
  for v_id in update private.teacher_student_terms set provider_identity=v_identity,updated_at=now() where tenant_id=tenant and teacher_id=uid and status='PROPOSED' and school_signed_at is null and teacher_signed_at is null returning id loop perform private.student_term_refresh(v_id);end loop;
  return jsonb_build_object('ok',true);
 elsif p_action='prepare' then
  if not is_staff or actor.lifecycle_status<>'active' then raise exception 'not_authorized' using errcode='42501';end if;
  v_id:=private.student_term_prepare(tenant,(p_payload->>'student_id')::uuid,(p_payload->>'teacher_id')::uuid,'MANUAL',coalesce(p_id,gen_random_uuid()),p_payload->>'mode',(p_payload->>'starts_on')::date,nullif(p_payload->>'ends_on','')::date,p_payload->'slots',null);
  return jsonb_build_object('ok',v_id is not null,'id',v_id);
 elsif p_action='enrollment_status' then
  if not exists(select 1 from public.offers where id=p_id and tenant_id=tenant and processing_by=uid and kind='ENROLLMENT') then raise exception 'not_authorized' using errcode='42501';end if;
  return jsonb_build_object('ok',true,'ready',private.student_term_enrollment(p_id,uid));
 end if;
 select * into r from private.teacher_student_terms where id=p_id and tenant_id=tenant for update;
 if r.id is null then raise exception 'term_not_found' using errcode='42501';end if;
 select exists(select 1 from public.profiles s where s.id=r.student_id and s.tenant_id=tenant and(s.id=uid or s.guardian_id=uid)) into is_family;
 if p_action='family_confirm' then
  if role_name<>'STUDENT' or not is_family or r.status not in('PROPOSED','EXECUTED') or p_payload->'confirmed' is distinct from 'true'::jsonb then raise exception 'not_authorized' using errcode='42501';end if;
  v_hash:=encode(extensions.digest(jsonb_build_object('id',r.id,'slots',r.slots,'from',r.starts_on,'until',r.ends_on)::text,'sha256'),'hex');
  if p_payload->>'schedule_hash' is distinct from v_hash or not private.student_term_source_valid(r) then raise exception 'Agenda alterada. Atualize e confira novamente.';end if;
  if r.family_confirmed_at is null then update private.teacher_student_terms set family_confirmed_at=clock_timestamp(),family_confirmation=jsonb_build_object('kind','AUTHENTICATED_FAMILY','actor_id',uid,'schedule_hash',v_hash),status=case when school_signed_at is not null and teacher_signed_at is not null then 'EXECUTED' else status end,updated_at=now() where id=r.id;
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash) values(r.id,uid,'FAMILY_SCHEDULE_CONFIRMED',r.content_hash);end if;
  return jsonb_build_object('ok',true);
 end if;
 if not(is_staff or(role_name='TEACHER' and r.teacher_id=uid)) then raise exception 'not_authorized' using errcode='42501';end if;
 if p_action in('revoke','reissue') then
  if not is_staff or length(btrim(coalesce(p_payload->>'reason','')))<10 then raise exception 'Informe o motivo da retirada ou reemissão.';end if;
  if exists(select 1 from private.teacher_student_term_bindings where term_id=r.id and ended_at is null) then raise exception 'Atendimento já atribuído. Use o fluxo oficial de encerramento ou alteração antes de retirar esta proposta.';end if;
  update private.teacher_student_terms set status='REVOKED',closed_reason=left(p_payload->>'reason',500),updated_at=now() where id=r.id;
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash,details) values(r.id,uid,'REVOKED_FOR_FUTURE_ASSIGNMENTS',r.content_hash,jsonb_build_object('reason',left(p_payload->>'reason',500)));
  if p_action='reissue' then
   perform set_config('app.student_term_reissue',r.source_id::text,true);
   v_id:=private.student_term_prepare(r.tenant_id,r.student_id,r.teacher_id,r.source_kind,r.source_id,r.mode,r.starts_on,r.ends_on,r.slots,r.family_confirmation);
   perform set_config('app.student_term_reissue','',true);
   return jsonb_build_object('ok',true,'id',v_id);
  end if;return jsonb_build_object('ok',true);
 elsif p_action='apply_transfer' then
  if not is_staff or actor.lifecycle_status<>'active' or r.source_kind<>'TRANSFER' or r.status<>'EXECUTED' or not private.student_term_source_valid(r) then raise exception 'Termo ou transferência indisponível.';end if;
  update public.teacher_transfers set status='ACCEPTED',decided_at=coalesce(decided_at,now()) where id=r.source_id and tenant_id=tenant and status='PENDING';
  perform public.apply_teacher_transfer(r.source_id);
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash) values(r.id,uid,'TRANSFER_ASSIGNMENT_CONFIRMED',r.content_hash);
  return jsonb_build_object('ok',true);
 elsif p_action='decline' then
  if role_name<>'TEACHER' or r.teacher_id<>uid or r.teacher_signed_at is not null or r.status<>'PROPOSED' then raise exception 'term_not_open';end if;
  update private.teacher_student_terms set status='DECLINED',closed_reason='Proposta recusada pelo prestador',updated_at=now() where id=r.id;
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash) values(r.id,uid,'DECLINED',r.content_hash);
  return jsonb_build_object('ok',true);
 elsif p_action='sign' then
  name:=btrim(coalesce(p_payload->>'typed_name',''));
  if p_payload->>'content_hash' is distinct from r.content_hash or p_payload->'accepted' is distinct from 'true'::jsonb or p_payload->'has_authority' is distinct from 'true'::jsonb or lower(name) is distinct from lower(btrim(actor.full_name)) then raise exception 'Confira o texto, a assinatura e a declaração de representação.';end if;
  if(role_name='SCHOOL_ADMIN' and r.school_signed_by=uid) or(role_name='TEACHER' and r.teacher_signed_by=uid) then return jsonb_build_object('ok',true,'already',true,'phase',private.student_term_phase(r));end if;
  if actor.lifecycle_status<>'active' or r.status<>'PROPOSED' or r.provider_identity is null or not private.student_term_source_valid(r) then raise exception 'Proposta indisponível ou fonte alterada. Solicite conferência à escola.';end if;
  if role_name='SCHOOL_ADMIN' then
   if r.school_signed_at is not null then raise exception 'school_already_signed';end if;
   update private.teacher_student_terms set school_signed_by=uid,school_signed_at=clock_timestamp(),school_typed_name=name,updated_at=now() where id=r.id;
   v:='SCHOOL_SIGNED';
  elsif role_name='TEACHER' and r.teacher_id=uid and lower(name)=lower(btrim(r.teacher_name)) and public.teacher_opportunity_recipient_eligible(tenant,uid) then
   if r.school_signed_at is null then raise exception 'Aguarde a manifestação da escola sobre esta versão.';end if;
   update private.teacher_student_terms set teacher_signed_by=uid,teacher_signed_at=clock_timestamp(),teacher_typed_name=name,status=case when family_confirmed_at is not null then 'EXECUTED' else status end,updated_at=now() where id=r.id;
   v:='TEACHER_SIGNED';
  else raise exception 'not_authorized' using errcode='42501';end if;
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash) values(r.id,uid,v,r.content_hash);
  select * into r from private.teacher_student_terms where id=p_id;
  return jsonb_build_object('ok',true,'phase',private.student_term_phase(r));
 end if;
 raise exception 'action_invalid';
end;$$;

create or replace function public.enrollment_teacher_terms_ready(p_offer_id uuid,p_student_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'service_required' using errcode='42501';end if;
 return private.student_term_enrollment(p_offer_id,p_student_id);
end;$$;
-- Preserva os validadores anteriores e todas as guardas financeiras. O ponto
-- de materialização fica fechado antes de qualquer operação com o Asaas.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.materialize_enrollment_offer_schedule(uuid,uuid)'::regprocedure);
 if strpos(s,'enrollment_teacher_terms_ready')=0 then
  anchor:='  with inserted as (';
  if strpos(s,anchor)=0 then raise exception 'materialization_anchor_changed';end if;
  s:=replace(s,anchor,E'  if not public.enrollment_teacher_terms_ready(p_offer_id,p_user_id) then\n    return jsonb_build_object(''success'',false,''error'',''TEACHER_TERM_PENDING'');\n  end if;\n\n'||anchor);execute s;
 end if;
 s:=pg_get_functiondef('public.complete_enrollment_offer_authoritative_impl(uuid,uuid)'::regprocedure);
 if strpos(s,'enrollment_teacher_terms_ready')=0 then
  anchor:='  v_invite_id := nullif(o.metadata';
  if strpos(s,anchor)=0 then raise exception 'completion_term_anchor_changed';end if;
  s:=replace(s,anchor,E'  if not public.enrollment_teacher_terms_ready(p_offer_id,p_user_id) then\n    return jsonb_build_object(''success'',false,''error'',''TEACHER_TERM_PENDING'');\n  end if;\n\n'||anchor);execute s;
 end if;
end;$patch$;
-- O hook de offers roda depois do snapshot de perfil, no mesmo commit. A
-- confirmação do contrato aluno-escola atualiza também a prova da agenda.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.record_enrollment_contract_terms(uuid,integer)'::regprocedure);
 if strpos(s,'student_term_enrollment')=0 then
  anchor:='  return jsonb_build_object(''ok'', true, ''terms_version'', v_version, ''already'', false);';
  if strpos(s,anchor)=0 then raise exception 'family_contract_anchor_changed';end if;
  execute replace(s,anchor,E'  perform private.student_term_enrollment(p_offer_id,v_user);\n'||anchor);
 end if;
end;$patch$;

-- Limita a superfície de execução. As tabelas privadas não são API de escrita.
do $$declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (p.proname like 'student_term_%' or p.proname in('guard_student_individual_term')) loop
 execute format('alter function %s owner to postgres',r.signature);
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end$$;
alter function public.teacher_student_terms(text,uuid,jsonb) owner to postgres;
revoke all on function public.teacher_student_terms(text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.teacher_student_terms(text,uuid,jsonb) to authenticated;
alter function public.enrollment_teacher_terms_ready(uuid,uuid) owner to postgres;
revoke all on function public.enrollment_teacher_terms_ready(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enrollment_teacher_terms_ready(uuid,uuid) to service_role;
notify pgrst,'reload schema';

create or replace function private.student_term_coverage_opportunity()
returns trigger language plpgsql security definer set search_path='' as $$
declare op public.coverage_opportunities;b public.bookings;slots jsonb;tid uuid;
begin
 select * into op from public.coverage_opportunities where id=new.opportunity_id;
 if not private.student_term_required(op.tenant_id,null) then return new;end if;
 select * into b from public.bookings where id=op.booking_id and tenant_id=op.tenant_id;
 slots:=jsonb_build_array(jsonb_build_object('date',op.class_date,'day',extract(dow from op.class_date)::int,'time',op.class_time));
 tid:=private.student_term_prepare(op.tenant_id,op.student_id,new.teacher_id,'COVERAGE_OPPORTUNITY',op.id,'DATED',op.class_date,op.class_date,slots,case when exists(select 1 from public.profiles where id=op.student_id and contract_accepted) then jsonb_build_object('kind','EXISTING_BOOKING_UNCHANGED','booking_id',b.id,'date',op.class_date,'time',op.class_time) end);
 return new;
end;$$;
alter function private.student_term_coverage_opportunity() owner to postgres;
revoke all on function private.student_term_coverage_opportunity() from public,anon,authenticated,service_role;
drop trigger if exists zz_student_term_coverage_opportunity on public.coverage_opportunity_invites;
create trigger zz_student_term_coverage_opportunity after insert on public.coverage_opportunity_invites for each row execute function private.student_term_coverage_opportunity();

create or replace function public.student_billing_teacher_terms_ready(p_tenant_id text,p_student_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o record;ready boolean:=true;
begin
 if (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'service_required' using errcode='42501';end if;
 for o in select id from public.offers where tenant_id=p_tenant_id and kind='ENROLLMENT' and processing_by=p_student_id and processing_state<>'COMPLETED' and revoked_at is null loop
  if not private.student_term_enrollment(o.id,p_student_id) then ready:=false;end if;
 end loop;
 if private.student_term_required(p_tenant_id,null) and exists(select 1 from public.profiles p join private.teacher_student_term_policy cfg on cfg.tenant_id=p.tenant_id where p.id=p_student_id and p.tenant_id=p_tenant_id and p.created_at>=cfg.starts_at)
 and not exists(select 1 from private.teacher_student_term_legacy_offers where tenant_id=p_tenant_id and student_id=p_student_id)
 and not exists(select 1 from private.teacher_student_terms t where t.tenant_id=p_tenant_id and t.student_id=p_student_id and t.status='EXECUTED' and t.retired_at is null and private.student_term_source_valid(t)) then return false;end if;
 return ready;
end;$$;
alter function public.student_billing_teacher_terms_ready(text,uuid) owner to postgres;
revoke all on function public.student_billing_teacher_terms_ready(text,uuid) from public,anon,authenticated;
grant execute on function public.student_billing_teacher_terms_ready(text,uuid) to service_role;

-- A ficha do aluno também não pode trocar o prestador sem uma proposta assinada.
-- O início por oferta ainda é apenas cadastro pendente e não confirma aula.
create or replace function private.guard_student_term_profile_assignment()
returns trigger language plpgsql security definer set search_path='' as $$
declare teacher uuid;
begin
 if new.role<>'STUDENT' or not private.student_term_required(new.tenant_id,null) then return new;end if;
 if tg_op='UPDATE' and row(new.professor_id,new.professor_id2) is not distinct from row(old.professor_id,old.professor_id2) then return new;end if;
 if exists(select 1 from public.offers where tenant_id=new.tenant_id and kind='ENROLLMENT' and processing_by=new.id and processing_state<>'COMPLETED' and revoked_at is null and new.professor_id is not distinct from nullif(payload->>'professorId','')::uuid and new.professor_id2 is not distinct from nullif(payload->>'professorId2','')::uuid) then return new;end if;
 if auth.uid()=new.id and exists(select 1 from private.enrollment_offer_schedule_slots slot join public.offers o on o.id=slot.offer_id and o.tenant_id=slot.tenant_id where slot.tenant_id=new.tenant_id and slot.reserved_by=new.id and slot.status='RESERVED' and slot.reservation_expires_at>now() and o.revoked_at is null and(o.processing_by is null or o.processing_by=new.id) and slot.teacher_id=new.professor_id) then return new;end if;
 foreach teacher in array array[new.professor_id,new.professor_id2] loop
  if teacher is null or(tg_op='UPDATE' and teacher in(old.professor_id,old.professor_id2)) then continue;end if;
  if private.student_term_legacy_transfer_allows(new.tenant_id,new.id,teacher) then continue;end if;
  if not exists(select 1 from private.teacher_student_terms t where t.tenant_id=new.tenant_id and t.student_id=new.id and t.teacher_id=teacher and t.status='EXECUTED' and t.retired_at is null and private.student_term_source_valid(t)) then
   raise exception using errcode='PT412',message='Assinatura do termo individual pendente. Abra Contratos > Termos por aluno.',detail='teacher_student_term_required';
  end if;
 end loop;return new;
end;$$;
alter function private.guard_student_term_profile_assignment() owner to postgres;
revoke all on function private.guard_student_term_profile_assignment() from public,anon,authenticated,service_role;
drop trigger if exists zz_require_student_term_profile on public.profiles;
create trigger zz_require_student_term_profile before insert or update of professor_id,professor_id2 on public.profiles for each row execute function private.guard_student_term_profile_assignment();

create or replace function private.student_term_stage_schedule(p_student uuid,p_changes jsonb,p_from date,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();tenant text:=private.active_tenant_id(auth.uid());role_name text:=private.active_tenant_role(auth.uid());change jsonb;b public.bookings;day integer;tm text;ids jsonb:='[]';tid uuid;source uuid;needs boolean:=false;manager boolean;
begin
 if not private.student_term_required(tenant,null) then return null;end if;
 manager:=coalesce(private.quality_school_manager(tenant),false);
 if actor is null or coalesce(role_name,'') not in('SCHOOL_ADMIN','COORDINATOR','TEACHER') then raise exception 'not_authorized' using errcode='42501';end if;
 if p_from is null or p_from<=(now() at time zone 'America/Sao_Paulo')::date or p_from>(now() at time zone 'America/Sao_Paulo')::date+366 or length(btrim(coalesce(p_reason,''))) not between 8 and 1000 or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 14 then raise exception 'invalid_schedule_proposal';end if;
 for change in select value from jsonb_array_elements(p_changes) order by value->>'booking_id' loop
  select * into b from public.bookings where id=(change->>'booking_id')::uuid and tenant_id=tenant and student_id=p_student and upper(status)='SCHEDULED' and date is null;
  if b.id is null or(not manager and b.teacher_id<>actor) then raise exception 'not_authorized' using errcode='42501';end if;
  day:=public.dow_name_to_int(change->>'new_day');tm:=left(change->>'new_time',5);
  if day not between 0 and 6 or day is null or tm !~ '^([01][0-9]|2[0-3]):(00|30)$' then raise exception 'invalid_schedule_proposal';end if;
  if(public.booking_schedule_on_date(b.id,p_from)->>'day_of_week')=public.canonical_weekday_name(change->>'new_day') and(public.booking_schedule_on_date(b.id,p_from)->>'time_slot')=tm then continue;end if;
  tid:=private.student_term_match(tenant,p_student,b.teacher_id,'RECURRING',day,tm,p_from);
  if tid is null then
   source:=md5('term-schedule:'||b.id||':'||p_from||':'||day||':'||tm)::uuid;
   tid:=private.student_term_prepare(tenant,p_student,b.teacher_id,'MANUAL',source,'RECURRING',p_from,null,jsonb_build_array(jsonb_build_object('day',day,'time',tm)),null);
   ids:=ids||jsonb_build_array(tid);needs:=true;
  end if;
 end loop;
 if needs then return jsonb_build_object('ok',true,'pending_terms',true,'changed',0,'term_ids',ids,'notification_queued',false);end if;
 return null;
end;$$;
alter function private.student_term_stage_schedule(uuid,jsonb,date,text) owner to postgres;
revoke all on function private.student_term_stage_schedule(uuid,jsonb,date,text) from public,anon,authenticated,service_role;
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.teacher_apply_student_schedule_change(uuid,jsonb,date,text)'::regprocedure);
 if strpos(s,'student_term_stage_schedule')=0 then
  anchor:='  v_actor uuid := auth.uid();';if strpos(s,anchor)=0 then raise exception 'schedule_declaration_changed';end if;s:=replace(s,anchor,anchor||E'\n  v_term_pending jsonb;');
  anchor:='  if v_actor is null or v_tenant is null then';if strpos(s,anchor)=0 then raise exception 'schedule_proposal_anchor_changed';end if;
  s:=replace(s,anchor,E'  v_term_pending:=private.student_term_stage_schedule(p_student_id,p_changes,p_effective_from,p_reason);\n  if v_term_pending is not null then return v_term_pending;end if;\n'||anchor);execute s;
 end if;
 -- A decisão administrativa cria uma proposta persistente sem atribuir o
 -- atendimento ao destino antes das manifestações individuais.
 s:=pg_get_functiondef('public.admin_schedule_student_transfer(uuid,uuid,jsonb,date,text,uuid)'::regprocedure);
 if strpos(s,'pending_terms')=0 then
  s:=replace(s,$old$existing.status not in ('ACCEPTED','APPLIED')$old$,$new$existing.status not in ('PENDING','ACCEPTED','APPLIED')$new$);
  s:=replace(s,$old$'idempotent',true)$old$,$new$'idempotent',true,'pending_terms',existing.status='PENDING')$new$);
  s:=replace(s,$old$'to_teacher_name',teacher_name)$old$,$new$'to_teacher_name',teacher_name,'pending_terms',existing.status='PENDING')$new$);execute s;
 end if;
end;$patch$;
create or replace function private.guard_student_term_transfer()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not private.student_term_required(new.tenant_id,null) then return new;end if;
 if tg_op='INSERT' and new.status='ACCEPTED' then new.status:='PENDING';new.decided_at:=null;return new;end if;
 if new.status='ACCEPTED' and(tg_op='INSERT' or old.status is distinct from 'ACCEPTED') and not exists(select 1 from private.teacher_student_terms t where t.source_kind='TRANSFER' and t.source_id=new.id and t.status='EXECUTED' and t.retired_at is null and private.student_term_source_valid(t)) then
  raise exception using errcode='PT412',message='Termo individual e confirmação da agenda pendentes. Conclua os aceites no portal.';
 end if;return new;
end;$$;
alter function private.guard_student_term_transfer() owner to postgres;
revoke all on function private.guard_student_term_transfer() from public,anon,authenticated,service_role;
drop trigger if exists aa_student_term_transfer_proposal on public.teacher_transfers;
create trigger aa_student_term_transfer_proposal before insert or update of status on public.teacher_transfers for each row execute function private.guard_student_term_transfer();
