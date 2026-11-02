-- Termo individual por link (01/11/2026): link criado entre 21h e 8h (Brasília)
-- espera até as 8h. Matrícula fechada às 23h não pode acordar o professor nem a
-- direção. Os lembretes já rodam só entre 9h e 21h; aqui é a primeira mensagem.
-- Remendo por âncora em private.student_term_issue_link — não recrie a função a
-- partir do texto da migration 20261101010000.

create or replace function private.student_term_send_at(p_now timestamptz default now())
returns timestamptz language sql stable set search_path='' as $$
 select case
  when extract(hour from p_now at time zone 'America/Sao_Paulo')>=21
   then ((((p_now at time zone 'America/Sao_Paulo')::date+1)+time '08:00') at time zone 'America/Sao_Paulo')
  when extract(hour from p_now at time zone 'America/Sao_Paulo')<8
   then ((((p_now at time zone 'America/Sao_Paulo')::date)+time '08:00') at time zone 'America/Sao_Paulo')
  else p_now end
$$;
alter function private.student_term_send_at(timestamptz) owner to postgres;
revoke all on function private.student_term_send_at(timestamptz) from public,anon,authenticated;

do $patch$
declare v_def text;
begin
 v_def:=pg_get_functiondef('private.student_term_issue_link(uuid,text,boolean)'::regprocedure);
 if position('student_term_send_at' in v_def)>0 then return; end if;
 if position('message_body,scheduled_for,status,' in v_def)=0 or position('v_msg,now(),''pending''' in v_def)=0 then
  raise exception 'termo por link: ancora do envio nao encontrada em student_term_issue_link';
 end if;
 v_def:=replace(v_def,'message_body,scheduled_for,status,','message_body,scheduled_for,next_attempt_at,status,');
 v_def:=replace(v_def,'v_msg,now(),''pending''','v_msg,private.student_term_send_at(now()),private.student_term_send_at(now()),''pending''');
 execute v_def;
end;
$patch$;
