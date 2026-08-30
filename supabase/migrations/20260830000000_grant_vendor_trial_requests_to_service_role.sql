-- Mantém o acesso da camada operacional (service_role) para operações internas de
-- migração e testes que precisam inserir no estado bruto do pedido de prova.
-- A escrita do aplicativo continua concentrada em functions de segurança (RESTRICTIVE).

do $$
begin
  if to_regclass('private.vendor_trial_teacher_requests') is not null then
    grant insert, select, update on table private.vendor_trial_teacher_requests to service_role;
  end if;
end $$;
