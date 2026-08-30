begin;

-- 20260827000000 simplified the payment ledger trigger after the hardened
-- invariant migration and accidentally restored destructive refund accounting:
-- a refund deleted its original cash receipt instead of recording a dated
-- contra-entry. Restore the audited implementation so cash remains gross and
-- every proven refund is an idempotent SAIDA tied to its provider event.
create or replace function public.ledger_on_payment_received()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt_should_exist boolean;
  v_receipt_existed boolean;
  v_cash_before boolean;
  v_relevant_change boolean;
  v_category text;
  v_refund_category text;
  v_gross_amount numeric;
  v_refund_delta numeric := 0;
  v_refund_event_fresh boolean := false;
  v_occurred_at timestamptz;
  v_existing_occurred_at timestamptz;
  v_removed_amount numeric;
  v_removed_count integer := 0;
  v_refund_inserted integer := 0;
  v_has_ledger boolean;
  v_existing_refund record;
  v_paid_teacher_closings jsonb;
  v_payment_competence text;
begin
  select exists (
           select 1
             from public.financial_transactions ft
            where ft.student_payment_id = new.id
         ),
         (
           select ft.occurred_at
             from public.financial_transactions ft
            where ft.student_payment_id = new.id
         )
    into v_receipt_existed, v_existing_occurred_at;

  v_cash_before := tg_op = 'UPDATE'
                   and (
                     old.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'NAO_RECEITA')
                     or v_receipt_existed
                   );
  v_receipt_should_exist :=
    new.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'NAO_RECEITA')
    or (
      new.status = 'REFUNDED'
      and (new.credited_at is not null or v_receipt_existed)
    );

  if tg_op = 'UPDATE'
     and coalesce(new.refunded_amount, 0) < coalesce(old.refunded_amount, 0) then
    raise exception using
      errcode = '23514',
      message = 'student_payment_refunded_amount_regression';
  end if;

  v_relevant_change := tg_op = 'INSERT'
    or old.status is distinct from new.status
    or old.tenant_id is distinct from new.tenant_id
    or old.student_id is distinct from new.student_id
    or old.value is distinct from new.value
    or old.refunded_amount is distinct from new.refunded_amount
    or old.credited_at is distinct from new.credited_at
    or old.last_provider_event_id is distinct from new.last_provider_event_id
    or old.last_provider_event_at is distinct from new.last_provider_event_at
    or old.paid_at is distinct from new.paid_at
    or old.payment_date is distinct from new.payment_date
    or old.due_date is distinct from new.due_date;

  -- Atualizacao recursiva feita abaixo apenas para espelhar a flag. Se nenhum
  -- campo contabil mudou, limita-se a restaurar a flag derivada.
  if not v_relevant_change then
    select exists (
      select 1
        from public.financial_transactions ft
       where ft.student_payment_id = new.id
    ) into v_has_ledger;

    if new.ledger_entry_created is distinct from v_has_ledger then
      update public.student_payments sp
         set ledger_entry_created = v_has_ledger
       where sp.id = new.id
         and sp.ledger_entry_created is distinct from v_has_ledger;
    end if;
    return new;
  end if;

  v_category := case
    when new.status = 'NAO_RECEITA' then 'aporte_ou_movimentacao'
    else 'MENSALIDADE'
  end;
  v_refund_category := case
    when new.status = 'NAO_RECEITA' then 'estorno_aporte_ou_movimentacao'
    else 'ESTORNO_MENSALIDADE'
  end;
  v_gross_amount := round(coalesce(new.value, 0), 2);
  v_occurred_at := coalesce(
    new.credited_at,
    new.paid_at,
    new.payment_date + interval '12 hours',
    new.due_date + interval '12 hours',
    v_existing_occurred_at,
    now()
  );

  -- O recebimento e imutavelmente bruto. Um estorno nunca reduz nem apaga esta
  -- linha: sua contrapartida vive em uma SAIDA datada pelo evento do provedor.
  if v_receipt_should_exist
     and new.tenant_id is not null
     and v_gross_amount > 0 then
    insert into public.financial_transactions (
      tenant_id,
      type,
      category,
      amount,
      amount_cents,
      student_payment_id,
      reference_id,
      occurred_at,
      description,
      created_at
    ) values (
      new.tenant_id,
      'ENTRADA',
      v_category,
      v_gross_amount,
      round(v_gross_amount * 100)::integer,
      new.id,
      new.student_id,
      v_occurred_at,
      case
        when new.status = 'NAO_RECEITA' then 'Movimentacao nao operacional (conciliacao automatica)'
        else 'Mensalidade (conciliacao automatica)'
      end,
      now()
    )
    on conflict (student_payment_id) where student_payment_id is not null
    do update set
      tenant_id = excluded.tenant_id,
      type = excluded.type,
      category = excluded.category,
      amount = excluded.amount,
      amount_cents = excluded.amount_cents,
      reference_id = excluded.reference_id,
      occurred_at = excluded.occurred_at,
      description = excluded.description;
  elsif new.status = 'REFUNDED' and v_receipt_existed then
    -- Nao destrua a entrada historica se a atualizacao de identidade/valor
    -- estiver incompleta. A divergencia fica explicita para conciliacao.
    insert into public.reconciliation_issues (
      tenant_id, kind, student_payment_id, details
    ) values (
      coalesce(new.tenant_id, 'master'),
      'REFUNDED_PAYMENT_RECEIPT_DATA_INVALID',
      new.id,
      jsonb_build_object(
        'status_novo', new.status,
        'tenant_id', new.tenant_id,
        'valor_bruto', new.value,
        'entrada_preservada', true,
        'registrado_em', now()
      )
    );
  else
    select ft.amount
      into v_removed_amount
      from public.financial_transactions ft
     where ft.student_payment_id = new.id
     for update;

    delete from public.financial_transactions ft
     where ft.student_payment_id = new.id;
    get diagnostics v_removed_count = row_count;

    if v_removed_count > 0 and v_cash_before then
      insert into public.reconciliation_issues (
        tenant_id,
        kind,
        student_payment_id,
        details
      ) values (
        coalesce(new.tenant_id, old.tenant_id, 'master'),
        case when new.tenant_id is null
          then 'PAYMENT_WITHOUT_TENANT'
          else 'PAYMENT_REVERSED'
        end,
        new.id,
        jsonb_build_object(
          'status_anterior', case when tg_op = 'UPDATE' then old.status else null end,
          'status_novo', new.status,
          'valor_bruto', new.value,
          'valor_estornado', new.refunded_amount,
          'valor_removido_do_caixa', v_removed_amount,
          'removido_em', now()
        )
      );
    end if;
  end if;

  -- Mudanca deliberada RECEIVED <-> NAO_RECEITA recategoriza tambem eventuais
  -- estornos, sem tocar em valor, ID ou data historica do evento.
  if new.tenant_id is not null then
    update public.financial_transactions ft
       set tenant_id = new.tenant_id,
           category = v_refund_category,
           reference_id = new.student_id,
           description = case
             when new.status = 'NAO_RECEITA'
               then 'Estorno de movimentacao nao operacional (evento Asaas)'
             else 'Estorno de mensalidade (evento Asaas)'
           end
     where ft.refund_student_payment_id = new.id
       and (
         ft.tenant_id is distinct from new.tenant_id
         or ft.category is distinct from v_refund_category
         or ft.reference_id is distinct from new.student_id
       );
  end if;

  -- Gate obrigatorio: um estorno so e SAIDA se houve ENTRADA comprovada.
  select exists (
    select 1
      from public.financial_transactions ft
     where ft.student_payment_id = new.id
  ) into v_has_ledger;

  if tg_op = 'INSERT' then
    v_refund_delta := round(coalesce(new.refunded_amount, 0), 2);
    v_refund_event_fresh := new.last_provider_event_id is not null
      and length(trim(new.last_provider_event_id)) between 1 and 240
      and new.last_provider_event_at is not null;
  else
    v_refund_delta := round(
      coalesce(new.refunded_amount, 0) - coalesce(old.refunded_amount, 0),
      2
    );
    v_refund_event_fresh := new.last_provider_event_id is not null
      and length(trim(new.last_provider_event_id)) between 1 and 240
      and new.last_provider_event_at is not null
      and (
        new.last_provider_event_id is distinct from old.last_provider_event_id
        or new.last_provider_event_at is distinct from old.last_provider_event_at
      );
  end if;

  if v_refund_delta > 0 and not v_has_ledger then
    -- Estorno anterior ao credito (por exemplo CONFIRMED -> REFUNDED) nao e
    -- saida de caixa: nenhum saldo havia sido disponibilizado. A issue abaixo
    -- guarda a explicacao, mas nenhuma movimentacao e sintetizada.
    null;
  elsif v_refund_delta > 0
        and v_refund_event_fresh
        and new.tenant_id is not null then
    insert into public.financial_transactions (
      tenant_id,
      type,
      category,
      amount,
      amount_cents,
      refund_student_payment_id,
      provider_event_id,
      reference_id,
      occurred_at,
      description,
      created_at
    ) values (
      new.tenant_id,
      'SAIDA',
      v_refund_category,
      v_refund_delta,
      round(v_refund_delta * 100)::integer,
      new.id,
      trim(new.last_provider_event_id),
      new.student_id,
      new.last_provider_event_at,
      case
        when new.status = 'NAO_RECEITA' then 'Estorno de movimentacao nao operacional (evento Asaas)'
        else 'Estorno de mensalidade (evento Asaas)'
      end,
      now()
    )
    on conflict (provider_event_id)
      where refund_student_payment_id is not null
        and provider_event_id is not null
    do nothing;
    get diagnostics v_refund_inserted = row_count;

    -- ON CONFLICT garante retry idempotente. Esta verificacao impede que um ID
    -- do provedor reutilizado ou um retry divergente seja aceito em silencio.
    select
      ft.refund_student_payment_id,
      ft.tenant_id,
      ft.type,
      ft.category,
      ft.amount,
      ft.occurred_at
      into v_existing_refund
      from public.financial_transactions ft
     where ft.refund_student_payment_id is not null
       and ft.provider_event_id = trim(new.last_provider_event_id);

    if not found
       or v_existing_refund.refund_student_payment_id is distinct from new.id
       or v_existing_refund.tenant_id is distinct from new.tenant_id
       or v_existing_refund.type is distinct from 'SAIDA'
       or v_existing_refund.category is distinct from v_refund_category
       or v_existing_refund.amount is distinct from v_refund_delta
       or v_existing_refund.occurred_at is distinct from new.last_provider_event_at then
      raise exception using
        errcode = '23505',
        message = 'refund_provider_event_conflict';
    end if;
  elsif v_refund_delta > 0 then
    insert into public.reconciliation_issues (
      tenant_id,
      kind,
      student_payment_id,
      details
    ) values (
      coalesce(new.tenant_id, 'master'),
      'REFUND_LEDGER_EVENT_CONTEXT_MISSING',
      new.id,
      jsonb_build_object(
        'valor_bruto', new.value,
        'valor_estornado_anterior', case
          when tg_op = 'UPDATE' then old.refunded_amount
          else 0
        end,
        'valor_estornado_novo', new.refunded_amount,
        'delta_sem_lancamento', v_refund_delta,
        'provider_event_id', new.last_provider_event_id,
        'provider_event_at', new.last_provider_event_at,
        'contexto_evento_novo', v_refund_event_fresh,
        'tenant_id_ausente', new.tenant_id is null,
        'data_sintetizada', false,
        'registrado_em', now()
      )
    );
  end if;

  if v_refund_delta > 0
     and not exists (
       select 1
         from public.financial_transactions ft
        where ft.student_payment_id = new.id
     ) then
    insert into public.reconciliation_issues (
      tenant_id, kind, student_payment_id, details
    ) values (
      coalesce(new.tenant_id, 'master'),
      'REFUND_WITHOUT_RECEIPT_LEDGER',
      new.id,
      jsonb_build_object(
        'valor_bruto', new.value,
        'delta_estornado', v_refund_delta,
        'provider_event_id', new.last_provider_event_id,
        'provider_event_at', new.last_provider_event_at,
        'entrada_sintetizada', false,
        'motivo', 'Nao ha data de credito comprovada para reconstruir a ENTRADA historica.',
        'registrado_em', now()
      )
    );
  end if;

  if v_refund_delta > 0 then
    insert into public.reconciliation_issues (
      tenant_id,
      kind,
      student_payment_id,
      details
    ) values (
      coalesce(new.tenant_id, 'master'),
      case
        when coalesce(new.refunded_amount, 0) < coalesce(new.value, 0)
          then 'PAYMENT_PARTIALLY_REFUNDED'
        else 'PAYMENT_FULLY_REFUNDED'
      end,
      new.id,
      jsonb_build_object(
        'valor_bruto', new.value,
        'valor_estornado_anterior', case
          when tg_op = 'UPDATE' then old.refunded_amount
          else 0
        end,
        'valor_estornado_novo', new.refunded_amount,
        'delta_estornado', v_refund_delta,
        'provider_event_id', new.last_provider_event_id,
        'provider_event_at', new.last_provider_event_at,
        'saida_criada', v_refund_inserted = 1,
        'registrado_em', now()
      )
    );
  end if;

  -- Um estorno posterior ao repasse do professor exige decisao humana. A
  -- mensalidade e o fechamento nao possuem regra de rateio reverso suficiente
  -- para debitar o professor com seguranca; por isso o trigger apenas abre uma
  -- issue com os fechamentos possivelmente afetados e nunca altera o repasse.
  if v_refund_delta > 0
     and new.student_id is not null then
    v_payment_competence := to_char(
      coalesce(new.due_date, new.payment_date, new.credited_at::date),
      'YYYY-MM'
    );

    select jsonb_agg(candidate.id order by candidate.id)
      into v_paid_teacher_closings
      from (
        select distinct tc.id
          from public.teacher_closings tc
         where tc.tenant_id = new.tenant_id
           and tc.month_year = v_payment_competence
           and upper(coalesce(tc.status, '')) in ('PAGO', 'PAID', 'COMPLETED')
           and exists (
             select 1
               from public.v_payable_class_logs pcl
              where pcl.teacher_id = tc.teacher_id
                and pcl.student_id = new.student_id
                and to_char(pcl.class_date, 'YYYY-MM') = v_payment_competence
           )
      ) candidate;

    if v_paid_teacher_closings is not null then
      insert into public.reconciliation_issues (
        tenant_id,
        kind,
        student_payment_id,
        details
      ) values (
        coalesce(new.tenant_id, 'master'),
        'REFUND_REQUIRES_TEACHER_PAYOUT_REVIEW',
        new.id,
        jsonb_build_object(
          'competencia', v_payment_competence,
          'fechamentos_pagos', v_paid_teacher_closings,
          'valor_bruto', new.value,
          'valor_estornado_anterior', case
            when tg_op = 'UPDATE' then old.refunded_amount
            else 0
          end,
          'valor_estornado_novo', new.refunded_amount,
          'acao_automatica', false,
          'motivo', 'Rateio ja liquidado exige revisao; nenhum debito automatico foi criado.',
          'registrado_em', now()
        )
      );
    end if;
  end if;

  select exists (
    select 1
      from public.financial_transactions ft
     where ft.student_payment_id = new.id
  ) into v_has_ledger;

  if new.ledger_entry_created is distinct from v_has_ledger then
    update public.student_payments sp
       set ledger_entry_created = v_has_ledger
     where sp.id = new.id
       and sp.ledger_entry_created is distinct from v_has_ledger;
  end if;

  return new;
end;
$function$;

alter function public.ledger_on_payment_received() owner to postgres;

comment on function public.ledger_on_payment_received() is
  'Fonte unica do caixa de mensalidades: uma ENTRADA bruta pela data de credito e uma SAIDA por evento real de estorno; CONFIRMED nunca e caixa e NAO_RECEITA preserva a classificacao.';

revoke all on function public.ledger_on_payment_received()
  from public, anon, authenticated;

drop trigger if exists trg_ledger_on_payment on public.student_payments;
create trigger trg_ledger_on_payment
  after insert or update
  on public.student_payments
  for each row execute function public.ledger_on_payment_received();

revoke all on function public.ledger_on_payment_received()
  from service_role;

do $postcheck$
declare
  ledger_oid regprocedure := 'public.ledger_on_payment_received()'::regprocedure;
  definition text;
  required_token text;
begin
  select pg_catalog.pg_get_functiondef(ledger_oid)
    into definition;

  foreach required_token in array array[
    'v_receipt_should_exist',
    'v_refund_delta',
    'refund_student_payment_id',
    'provider_event_id',
    'student_payment_refunded_amount_regression',
    'REFUND_WITHOUT_RECEIPT_LEDGER',
    'REFUND_REQUIRES_TEACHER_PAYOUT_REVIEW'
  ]::text[]
  loop
    if pg_catalog.strpos(definition, required_token) = 0 then
      raise exception 'immutable gross ledger trigger lost invariant %',
        required_token;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
     where procedure.oid = ledger_oid
       and (
         not procedure.prosecdef
         or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
         or not coalesce(
           procedure.proconfig @> array['search_path=""']::text[],
           false
         )
       )
  )
    or pg_catalog.has_function_privilege('anon', ledger_oid, 'EXECUTE')
    or pg_catalog.has_function_privilege(
      'authenticated', ledger_oid, 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'service_role', ledger_oid, 'EXECUTE'
    )
    or not exists (
      select 1
        from pg_catalog.pg_trigger as trigger_definition
       where trigger_definition.tgrelid =
               'public.student_payments'::pg_catalog.regclass
         and trigger_definition.tgname = 'trg_ledger_on_payment'
         and not trigger_definition.tgisinternal
         and trigger_definition.tgfoid = ledger_oid
    )
  then
    raise exception 'immutable gross ledger trigger hardening failed';
  end if;
end;
$postcheck$;

commit;
