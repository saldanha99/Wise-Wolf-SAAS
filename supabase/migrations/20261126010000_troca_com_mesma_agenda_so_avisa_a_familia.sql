-- Troca de professor com os mesmos horários não pede confirmação da família
-- (decisão da direção, 26/11/2026). Caso: os alunos da Teacher Bruna passaram ao
-- Teacher Daniel e à Teacher Laís nos MESMOS dias e horários, e a troca ficou
-- parada esperando cada família confirmar uma agenda que não mudou.
--
-- A confirmação da família continua valendo quando a agenda é nova (matrícula,
-- dia ou horário diferente). Na troca que só muda o professor, o termo nasce com
-- a família dispensada (kind SAME_SCHEDULE_NOTICE), executa com as assinaturas da
-- escola e do professor, e a família recebe só um aviso ("a partir de dd/mm suas
-- aulas serão com o teacher X, nos mesmos horários"). Nada de link.

-- A agenda proposta é igual à agenda fixa atual do aluno com o professor anterior?
create or replace function private.student_term_same_schedule(p_term private.teacher_student_terms)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_from uuid; v_new text[]; v_old text[];
begin
  if p_term.source_kind is distinct from 'TRANSFER' or p_term.source_id is null then return false; end if;
  select tr.from_teacher_id into v_from from public.teacher_transfers tr
   where tr.id = p_term.source_id and tr.tenant_id = p_term.tenant_id and tr.student_id = p_term.student_id;
  if v_from is null or v_from = p_term.teacher_id then return false; end if;
  -- Aula com data marcada não é agenda fixa: trata como agenda nova.
  if jsonb_typeof(p_term.slots) <> 'array' or jsonb_array_length(p_term.slots) = 0
     or exists (select 1 from jsonb_array_elements(p_term.slots) s where nullif(s->>'date', '') is not null) then
    return false;
  end if;
  select array_agg(distinct (s->>'day') || '|' || left(s->>'time', 5) order by (s->>'day') || '|' || left(s->>'time', 5))
    into v_new from jsonb_array_elements(p_term.slots) s;
  select array_agg(distinct public.dow_name_to_int(b.day_of_week)::text || '|' || left(b.time_slot, 5)
                   order by public.dow_name_to_int(b.day_of_week)::text || '|' || left(b.time_slot, 5))
    into v_old from public.bookings b
   where b.student_id = p_term.student_id and b.teacher_id = v_from and b.status = 'SCHEDULED'
     and b.tenant_id = p_term.tenant_id;
  return v_old is not null and v_new = v_old;
end;$$;
alter function private.student_term_same_schedule(private.teacher_student_terms) owner to postgres;
revoke all on function private.student_term_same_schedule(private.teacher_student_terms) from public, anon, authenticated, service_role;

create or replace function private.student_term_same_schedule_waive_family()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.family_confirmed_at is null and new.status = 'PROPOSED' and private.student_term_same_schedule(new) then
    new.family_confirmed_at := now();
    new.family_confirmation := jsonb_build_object('kind', 'SAME_SCHEDULE_NOTICE',
      'basis', 'Troca de professor com os mesmos dias e horários: a família é avisada, sem confirmar.');
  end if;
  return new;
end;$$;
alter function private.student_term_same_schedule_waive_family() owner to postgres;
revoke all on function private.student_term_same_schedule_waive_family() from public, anon, authenticated, service_role;
drop trigger if exists aa_student_term_same_schedule on private.teacher_student_terms;
create trigger aa_student_term_same_schedule before insert on private.teacher_student_terms
  for each row execute function private.student_term_same_schedule_waive_family();

-- Termo dispensado executa → aviso à família (a menos que a direção avise por conta própria).
create or replace function private.student_term_same_schedule_notify_family()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_student text; v_teacher text; v_phone text; v_first text;
begin
  if new.status is distinct from 'EXECUTED' or old.status is not distinct from 'EXECUTED'
     or new.family_confirmation->>'kind' is distinct from 'SAME_SCHEDULE_NOTICE' then return null; end if;
  if coalesce(current_setting('app.student_term_family_notice_silent', true), '') = 'on' then return null; end if;
  begin
    if not public.is_student_notifiable(new.student_id) then return null; end if;
    v_phone := private.student_term_family_phone(new.student_id);
    if v_phone is null then return null; end if;
    select full_name into v_student from public.profiles where id = new.student_id;
    select full_name into v_teacher from public.profiles where id = new.teacher_id;
    v_first := split_part(btrim(coalesce(v_student, '')), ' ', 1);
    insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
    values (new.tenant_id, new.teacher_id, new.student_id, v_student, v_phone,
      format(E'Oi, %s! 🐺 A partir de %s, suas aulas passam a ser com o(a) teacher *%s*, nos mesmos dias e horários de sempre:\n📅 %s\nVocê não precisa fazer nada. Qualquer dúvida, é só responder aqui.',
        v_first, to_char(new.starts_on, 'DD/MM'), v_teacher, private.student_term_agenda_text(new.slots)),
      private.student_term_send_at(now()), private.student_term_send_at(now()), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE',
      format('student-term:%s:same-schedule-notice', new.id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
  exception when others then
    raise warning '[termo individual] aviso da troca à família falhou para %: %', new.id, sqlerrm;
  end;
  return null;
end;$$;
alter function private.student_term_same_schedule_notify_family() owner to postgres;
revoke all on function private.student_term_same_schedule_notify_family() from public, anon, authenticated, service_role;
drop trigger if exists zz_student_term_same_schedule_notice on private.teacher_student_terms;
create trigger zz_student_term_same_schedule_notice after update of status on private.teacher_student_terms
  for each row execute function private.student_term_same_schedule_notify_family();

-- Defeito achado ao testar (26/11): quando a família confirma pelo link, a página age
-- como o aluno, e aplicar a troca muda o professor na ficha dele — a trava
-- protect_student_sensitive_profile_fields recusa ("campos contratuais exigem fluxo
-- autorizado") quando quem age é o próprio aluno. A troca ficava PENDING. Quem aplica
-- a troca é o sistema: a identidade da requisição sai durante a aplicação e volta depois.
create or replace function private.student_term_apply_transfer_on_executed()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
 if new.status is distinct from 'EXECUTED' or old.status is not distinct from 'EXECUTED' or new.source_kind <> 'TRANSFER' then return null;end if;
 if exists(select 1 from public.teacher_departure_offers o where o.transfer_id=new.source_id) then return null;end if;
 perform set_config('request.jwt.claims', '', true);
 perform set_config('request.jwt.claim.sub', '', true);
 begin
  update public.teacher_transfers set status='ACCEPTED',decided_at=coalesce(decided_at,now())
   where id=new.source_id and tenant_id=new.tenant_id and status='PENDING';
  -- Aplica já se a data da troca chegou; senão a rotina das 6h aplica no dia.
  perform public.apply_teacher_transfer(new.source_id);
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash,details)
  values(new.id,null,'TRANSFER_APPLIED_AUTOMATICALLY',new.content_hash,jsonb_build_object('transfer_id',new.source_id));
 exception when others then
  raise warning '[termo individual] troca % não aplicada após o termo: %',new.source_id,sqlerrm;
 end;
 perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
 perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
 return null;
end;$$;
alter function private.student_term_apply_transfer_on_executed() owner to postgres;
revoke all on function private.student_term_apply_transfer_on_executed() from public, anon, authenticated, service_role;
