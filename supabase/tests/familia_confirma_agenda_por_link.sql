-- Família confirma a agenda pelo link do WhatsApp; termo de troca completo aplica a troca.
begin;
do $$
declare t private.teacher_student_terms; v_body text; v_token text; v jsonb; r jsonb; v_transfer text;
begin
  if not has_function_privilege('anon', 'public.student_term_link_act(text,text,jsonb)', 'EXECUTE') then
    raise exception 'a família abre o link sem login';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'student_term_links_signer_check') not like '%FAMILY%' then
    raise exception 'o link precisa aceitar a família';
  end if;

  select * into t from private.teacher_student_terms
   where status = 'PROPOSED' and retired_at is null and teacher_signed_at is not null and family_confirmed_at is null
     and private.student_term_source_valid(teacher_student_terms) and public.is_student_notifiable(student_id)
     and private.student_term_family_phone(student_id) is not null
   order by created_at limit 1;
  if t.id is null then return; end if; -- nenhum termo esperando a família agora

  -- Professor não assinou → sem link da família.
  if private.student_term_issue_link(t.id, 'TEACHER') then raise exception 'professor já assinou, não há link dele'; end if;

  if not private.student_term_issue_link(t.id, 'FAMILY') then raise exception 'link da família não saiu para %', t.id; end if;
  select message_body into v_body from public.notification_queue
   where idempotency_key like 'student-term-link:' || t.id || ':family:%' order by created_at desc, idempotency_key desc limit 1;
  if v_body is null or v_body not like '%confirme sua agenda%' then raise exception 'mensagem da família não enfileirada: %', v_body; end if;
  if v_body ~ 'R\$' then raise exception 'a família não vê valor'; end if;
  v_token := substring(v_body from 'aceitar-termo\?t=([0-9a-f]{64})');

  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  v := public.student_term_link_view(v_token);
  if v->>'signer' <> 'FAMILY' or v ? 'unit_rate' or v ? 'body' then raise exception 'a família vê só a agenda: %', v; end if;

  r := public.student_term_link_act(v_token, 'sign', '{}');
  if r->>'error' <> 'acao_invalida' then raise exception 'família não assina termo: %', r; end if;

  r := public.student_term_link_act(v_token, 'confirm', '{}');
  if (r->>'ok')::boolean is distinct from true then raise exception 'confirmação pelo link falhou: %', r; end if;
  select * into t from private.teacher_student_terms where id = t.id;
  if t.family_confirmed_at is null or t.family_confirmation->>'kind' <> 'AUTHENTICATED_FAMILY' then raise exception 'agenda não confirmada'; end if;
  if not exists (select 1 from private.teacher_student_term_events where term_id = t.id and event = 'FAMILY_CONFIRMED_VIA_WHATSAPP_LINK') then
    raise exception 'meio da confirmação não registrado';
  end if;
  if public.student_term_link_view(v_token)->>'reason' <> 'used' and t.status = 'PROPOSED' then raise exception 'link usado não reabre'; end if;

  if t.school_signed_at is not null then
    if t.status <> 'EXECUTED' then raise exception 'com todos os aceites o termo fica completo'; end if;
    if t.source_kind = 'TRANSFER' and not exists (select 1 from public.teacher_departure_offers o where o.transfer_id = t.source_id) then
      select status into v_transfer from public.teacher_transfers where id = t.source_id;
      if v_transfer not in ('ACCEPTED', 'APPLIED') then raise exception 'a troca deveria seguir sozinha: %', v_transfer; end if;
    end if;
  end if;
end $$;
rollback;
