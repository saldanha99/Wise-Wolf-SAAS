-- A trava de envio precisa reconhecer a mesma pessoa com e sem o 9º dígito.
--
-- Em 15/09/2026, 18 agendas diárias de professor não saíram porque o WhatsApp
-- devolve o JID de conta antiga sem o 9 e a regra antiga via "outra pessoa".
-- Números sintéticos.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.assert_true(
  private.notification_phones_same_recipient('5511990001234', '551190001234'),
  'celular com e sem o 9º dígito deveria ser a mesma pessoa'
);
select pg_temp.assert_true(
  private.notification_phones_same_recipient('11990001234', '551190001234@s.whatsapp.net'),
  'cadastro sem DDI contra o JID do WhatsApp deveria casar'
);
select pg_temp.assert_true(
  private.notification_phones_same_recipient('5511990001234', '5511990001234'),
  'o mesmo número deveria casar'
);
select pg_temp.assert_true(
  not private.notification_phones_same_recipient('5511990001234', '552190001234'),
  'DDD diferente não pode casar'
);
select pg_temp.assert_true(
  not private.notification_phones_same_recipient('5511990001234', '551190001235'),
  'número diferente não pode casar'
);
select pg_temp.assert_true(
  not private.notification_phones_same_recipient('5511932345678', '551132345678'),
  'fixo (8 dígitos começando com 2–5) não pode virar celular'
);
select pg_temp.assert_true(
  not private.notification_phones_same_recipient('', '551190001234'),
  'destino vazio não pode casar'
);

rollback;
