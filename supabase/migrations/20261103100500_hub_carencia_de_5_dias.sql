-- Carência de 5 dias no atraso do Hub (decisão do dono, 03/11/2026).
--
-- Uma regra só para "esta assinatura dá acesso pago agora?":
--   TRIALING            -> trial_ends_at > now() (sem carência)
--   ACTIVE ou PAST_DUE  -> current_period_ends_at + 5 dias > now()
--   qualquer outro      -> não
-- Depois dos 5 dias nada é apagado: a assinatura só deixa de conceder acesso
-- (a gestão fica só leitura). Os pontos que decidiam acesso pago com a regra
-- copiada à mão passam a chamar o helper, por remendo por âncora (mantém
-- dono, grants e o resto do corpo das funções vivas):
--   private.hub_reserve_feature_internal  (biblioteca, Wolfie e Educador IA)
--   private.hub_commit_feature_internal   (confirmação da mesma reserva)
--   private.hub_consume_feature_internal  (consumo legado direto)
--   private.hub_bootstrap_internal        (assinatura vigente do bootstrap)
--   private.hub_user_has_educator_planner_access (Planner do educador)
-- E a renovação do Hub paga durante a carência continua a contar do fim do
-- período anterior (private.hub_activate_paid_checkout_apply): o atraso não
-- vira dias de graça somados a um mês novo inteiro (o mesmo pagamento nunca
-- compra dois períodos: o razão hub_subscription_payments já garante).
--
-- Fora daqui, de propósito: private.hub_learner_seats e as RPCs do aluno
-- (outra frente liga a elas este helper) e o Wolfie avulso
-- (private.wolfie_access_snapshot), que não entrou na decisão da carência.

create or replace function private.hub_subscription_grants_access(
  p_status text,
  p_trial_ends_at timestamptz,
  p_current_period_ends_at timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when p_status = 'TRIALING'
      then coalesce(p_trial_ends_at > pg_catalog.now(), false)
    when p_status in ('ACTIVE', 'PAST_DUE')
      then coalesce(
        p_current_period_ends_at + interval '5 days' > pg_catalog.now(),
        false
      )
    else false
  end;
$function$;

alter function private.hub_subscription_grants_access(text,timestamptz,timestamptz)
  owner to postgres;
revoke all on function private.hub_subscription_grants_access(text,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
-- Os chamadores são SECURITY DEFINER de supabase_admin e de postgres.
grant execute on function private.hub_subscription_grants_access(text,timestamptz,timestamptz)
  to supabase_admin;

comment on function private.hub_subscription_grants_access(text,timestamptz,timestamptz) is
  'Acesso pago do Hub: trial vigente, ou ACTIVE/PAST_DUE até 5 dias depois do fim do período.';

do $patch$
declare
  v_item record;
  v_def text;
  v_count integer;
begin
  for v_item in
    select *
    from (values
      (
        'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)',
        $old$    and (
      (
        subscription.status = 'TRIALING'
        and subscription.trial_ends_at > pg_catalog.now()
      )
      or (
        subscription.status = 'ACTIVE'
        and coalesce(
          subscription.current_period_ends_at,
          '-infinity'::timestamptz
        ) > pg_catalog.now()
      )
    )$old$,
        $new$    and private.hub_subscription_grants_access(
      subscription.status,
      subscription.trial_ends_at,
      subscription.current_period_ends_at
    )$new$
      ),
      (
        'private.hub_consume_feature_internal(text,integer,uuid,uuid,jsonb)',
        $old$    and (
      (
        subscription.status = 'TRIALING'
        and subscription.trial_ends_at > pg_catalog.now()
      )
      or (
        subscription.status = 'ACTIVE'
        and coalesce(
          subscription.current_period_ends_at,
          '-infinity'::timestamptz
        ) > pg_catalog.now()
      )
    )$old$,
        $new$    and private.hub_subscription_grants_access(
      subscription.status,
      subscription.trial_ends_at,
      subscription.current_period_ends_at
    )$new$
      ),
      (
        'private.hub_bootstrap_internal(uuid)',
        $old$      and (
        (
          candidate.status = 'TRIALING'
          and candidate.trial_ends_at > pg_catalog.now()
        )
        or (
          candidate.status = 'ACTIVE'
          and coalesce(
            candidate.current_period_ends_at,
            '-infinity'::timestamptz
          ) > pg_catalog.now()
        )
      )$old$,
        $new$      and private.hub_subscription_grants_access(
        candidate.status,
        candidate.trial_ends_at,
        candidate.current_period_ends_at
      )$new$
      ),
      (
        'private.hub_user_has_educator_planner_access(uuid,uuid)',
        $old$        and (
          (
            subscription.status = 'TRIALING'
            and subscription.trial_ends_at > pg_catalog.now()
          )
          or (
            subscription.status = 'ACTIVE'
            and coalesce(
              subscription.current_period_ends_at,
              '-infinity'::timestamptz
            ) > pg_catalog.now()
          )
        )$old$,
        $new$        and private.hub_subscription_grants_access(
          subscription.status,
          subscription.trial_ends_at,
          subscription.current_period_ends_at
        )$new$
      ),
      (
        'private.hub_commit_feature_internal(uuid,uuid,uuid,uuid)',
        $old$     or not (
       (
         v_subscription.status = 'TRIALING'
         and v_subscription.trial_ends_at > pg_catalog.now()
       )
       or (
         v_subscription.status = 'ACTIVE'
         and coalesce(
           v_subscription.current_period_ends_at,
           '-infinity'::timestamptz
         ) > pg_catalog.now()
       )
     ) then$old$,
        $new$     or not private.hub_subscription_grants_access(
       v_subscription.status,
       v_subscription.trial_ends_at,
       v_subscription.current_period_ends_at
     ) then$new$
      ),
      (
        'private.hub_activate_paid_checkout_apply(uuid,text)',
        $old$  v_period_start := case
    when v_is_renewal then greatest($old$,
        $new$  v_period_start := case
    -- Renovação paga na carência de 5 dias: o período novo começa no fim do
    -- anterior, não no dia do pagamento (a carência já faz parte dele). Só
    -- no Hub: o Wolfie avulso não tem carência de acesso, então não paga
    -- pelos dias em que ficou sem ele.
    when v_is_renewal
      and v_checkout.product_family = 'HUB_CORE'
      and v_subscription.current_period_ends_at is not null
      and v_subscription.current_period_ends_at <= pg_catalog.now()
      and private.hub_subscription_grants_access(
        v_subscription.status,
        v_subscription.trial_ends_at,
        v_subscription.current_period_ends_at
      ) then v_subscription.current_period_ends_at
    when v_is_renewal then greatest($new$
      )
    ) as patch(signature, old_text, new_text)
  loop
    if pg_catalog.to_regprocedure(v_item.signature) is null then
      raise exception 'carencia do hub: funcao % nao encontrada', v_item.signature;
    end if;
    v_def := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_item.signature)
    );
    -- Re-execução do release: já remendada, segue.
    if pg_catalog.strpos(v_def, 'private.hub_subscription_grants_access(') > 0 then
      continue;
    end if;
    v_count := (
      pg_catalog.length(v_def)
      - pg_catalog.length(pg_catalog.replace(v_def, v_item.old_text, ''))
    ) / pg_catalog.length(v_item.old_text);
    if v_count <> 1 then
      raise exception 'carencia do hub: ancora encontrada % vez(es) em %',
        v_count, v_item.signature;
    end if;
    execute pg_catalog.replace(v_def, v_item.old_text, v_item.new_text);
  end loop;
end;
$patch$;

-- Prova de que nenhum ponto de acesso pago do Hub ficou com a regra antiga.
do $assert$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)',
    'private.hub_consume_feature_internal(text,integer,uuid,uuid,jsonb)',
    'private.hub_bootstrap_internal(uuid)',
    'private.hub_user_has_educator_planner_access(uuid,uuid)',
    'private.hub_commit_feature_internal(uuid,uuid,uuid,uuid)',
    'private.hub_activate_paid_checkout_apply(uuid,text)'
  ] loop
    if pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature)),
      'private.hub_subscription_grants_access('
    ) = 0 then
      raise exception 'carencia do hub: % sem o helper', v_signature;
    end if;
  end loop;
end;
$assert$;
