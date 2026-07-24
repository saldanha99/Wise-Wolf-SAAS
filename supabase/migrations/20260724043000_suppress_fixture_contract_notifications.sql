begin;

-- O aceite deve enfileirar a boas-vindas somente na transição false -> true.
-- Atualizações financeiras posteriores não podem gerar novas tentativas. A
-- Edge Function continua sendo a barreira final para a primeira atualização de
-- uma fixture, pois o marcador testMode é propagado na mesma transação.
create or replace function public.handle_contract_signed_hook()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $function$
declare
  service_key text;
begin
  if new.contract_accepted is true
     and coalesce(old.contract_accepted, false) is false
     and coalesce(new.wa_welcome_sent, false) is false
     and coalesce(new.is_test_account, false) is false then
    begin
      select decrypted_secret
        into service_key
        from vault.decrypted_secrets
       where name = 'wisewolf_service_role_key'
       limit 1;

      if service_key is null or service_key = '' then
        raise exception 'service key ausente';
      end if;

      if new.phone is not null then
        insert into public.whatsapp_messages_log (
          student_id, phone, message_type, status
        )
        values (new.id, new.phone, 'WELCOME_ENROLLMENT', 'QUEUED');

        perform net.http_post(
          url := 'http://kong:8000/functions/v1/whatsapp-notificacao-matricula',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
          ),
          body := jsonb_build_object('student_id', new.id),
          timeout_milliseconds := 60000
        );
      else
        raise warning 'handle_contract_signed_hook: profile % sem phone', new.id;
      end if;
    exception when others then
      raise warning 'handle_contract_signed_hook: falha para %: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end;
$function$;

revoke all on function public.handle_contract_signed_hook()
  from public, anon, authenticated;

commit;
