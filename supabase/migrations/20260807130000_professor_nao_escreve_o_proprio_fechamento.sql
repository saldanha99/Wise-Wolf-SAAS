-- O professor não escreve o próprio fechamento.
--
-- O que existia (medido na VPS, em transação revertida, com professor real):
--
--   Duas policies permissivas de UPDATE — "Teachers can update (confirm/contest)
--   their own closings" e "Teachers update own closings" — ambas só com
--   `auth.uid() = teacher_id`, nenhuma restringindo COLUNA e nenhuma com
--   WITH CHECK. Mais uma de INSERT ("Teachers insert own closings") com o mesmo
--   escopo. Policies permissivas somam com OR: bastava um PATCH/POST direto no
--   PostgREST, sem passar por tela nenhuma, para o professor:
--
--     [1] total_amount   R$ 632,00 -> R$ 99.999,00     (UPDATE 1)
--     [2] status/paid_at PENDENTE  -> PAID + paid_at    (UPDATE 1)
--     [3] class_log_ids  -> {} e total_lessons -> 999   (UPDATE 1)
--     [4] INSERT de um fechamento inteiro, mês sem linha,
--         R$ 50.000,00 já com status PAID                (INSERT 0 1)
--
--   [4] é o pior: não precisava nem de fechamento existente. O escopo entre
--   professores, esse sim, já segurava ([5] contra a linha de outra professora:
--   UPDATE 0).
--
-- A regra que fica: a confirmação do professor é uma OPINIÃO SOBRE o número,
-- nunca uma ESCRITA DO número. Ele pode dizer "confiro" / "contesto, porque
-- ..." e anexar a NF. O valor, a contagem de aulas, o status e o snapshot de
-- class_log_ids são do servidor.
--
-- Caminho: mesmo padrão de `log_teacher_classes` — RPC SECURITY DEFINER com
-- `teacher_id` sempre em `auth.uid()` (não existe parâmetro para agir em nome
-- de outra pessoa), e a escrita direta revogada.
--
-- ⚠️ A RPC NÃO reescreve total_amount de linha que já existe. `run_monthly_
--    teacher_closing` soma carry-over e ajustes que `get_teacher_closing_report`
--    não enxerga; recalcular por cima apagaria o carry-over do professor. Só o
--    INSERT (professor confirma antes do cron rodar) calcula, e calcula no
--    servidor pela RPC canônica — nunca pelo número que a tela mandar.
--
-- Re-executável: DROP POLICY IF EXISTS, CREATE OR REPLACE, REVOKE idempotente,
-- e uma verificação final que falha se sobrar caminho de escrita para professor.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Fecha a escrita direta
-- ---------------------------------------------------------------------------

-- As duas de UPDATE eram a mesma regra escrita duas vezes (uma com o lado
-- invertido). Nenhuma restringia coluna, nenhuma tinha WITH CHECK.
DROP POLICY IF EXISTS "Teachers can update (confirm/contest) their own closings"
  ON public.teacher_closings;
DROP POLICY IF EXISTS "Teachers update own closings"
  ON public.teacher_closings;

-- INSERT direto era o buraco maior: fechamento fabricado do nada, com valor e
-- status escolhidos. Quem cria linha agora é a RPC (ou o cron, ou o diretor).
DROP POLICY IF EXISTS "Teachers insert own closings"
  ON public.teacher_closings;

-- Leitura continua: o professor precisa ver o próprio fechamento. As duas
-- policies de SELECT são redundantes entre si, mas leitura do próprio dado não
-- é o risco desta migration — ficam como estão.

-- O diretor continua escrevendo por policy (teacher_closings_tenant_admin, FOR
-- ALL, com WITH CHECK repetindo a condição do USING). Reafirmado aqui para a
-- migration ser autossuficiente caso rode em base onde ela não exista.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'teacher_closings'
       AND policyname = 'teacher_closings_tenant_admin'
  ) THEN
    CREATE POLICY teacher_closings_tenant_admin ON public.teacher_closings
      FOR ALL TO authenticated
      USING (
        public._my_role() = 'SUPER_ADMIN'
        OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
      )
      WITH CHECK (
        public._my_role() = 'SUPER_ADMIN'
        OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
      );
  END IF;
END
$$;

-- TRUNCATE não passa por RLS. O grant estava aberto para `authenticated` e
-- `anon` — nenhuma policy seguraria um TRUNCATE na folha inteira. Ninguém usa.
REVOKE TRUNCATE ON public.teacher_closings FROM anon, authenticated;

-- `anon` não tem policy nenhuma nesta tabela; o grant de escrita era só
-- superfície sobrando.
REVOKE INSERT, UPDATE, DELETE ON public.teacher_closings FROM anon;

-- `authenticated` MANTÉM INSERT/UPDATE/DELETE: é por esse papel que o diretor
-- escreve, via teacher_closings_tenant_admin. Quem barra o professor é a RLS,
-- não o grant.

-- ---------------------------------------------------------------------------
-- 2. Confirmação / contestação do mês
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_submit_closing(
  p_month text,
  p_confirmation text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_teacher uuid := auth.uid();
  v_profile record;
  v_confirm text;
  v_notes text;
  v_row public.teacher_closings;
  v_report jsonb;
  v_lessons int;
  v_amount numeric;
  v_created boolean := false;
begin
  ---------------------------------------------------------------------------
  -- Autenticação e escopo. `teacher_id` é SEMPRE auth.uid(): não existe
  -- parâmetro para confirmar o fechamento de outra pessoa.
  ---------------------------------------------------------------------------
  if v_teacher is null or auth.role() <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select p.id, p.tenant_id, p.role
    into v_profile
    from public.profiles p
   where p.id = v_teacher;

  if not found
     or v_profile.tenant_id is null
     or v_profile.role not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;

  if p_month is null or p_month !~ '^\d{4}-\d{2}$' then
    raise exception using errcode = '22023', message = 'invalid_month';
  end if;

  v_confirm := upper(pg_catalog.btrim(coalesce(p_confirmation, '')));
  if v_confirm not in ('OK', 'CONTESTADO') then
    raise exception using errcode = '22023', message = 'invalid_confirmation';
  end if;

  -- Contestação sem motivo não serve para nada: o diretor não teria o que
  -- resolver, e a linha ficaria travada sem explicação.
  v_notes := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  if v_confirm = 'CONTESTADO' and v_notes is null then
    raise exception using errcode = '22023', message = 'contestacao_exige_motivo';
  end if;
  if v_confirm = 'OK' then
    v_notes := null;
  else
    v_notes := pg_catalog.left(v_notes, 2000);
  end if;

  ---------------------------------------------------------------------------
  -- Linha existente: SÓ os campos de confirmação. Valor, contagem, status,
  -- class_log_ids e paid_at não são tocados aqui em hipótese nenhuma.
  ---------------------------------------------------------------------------
  select tc.* into v_row
    from public.teacher_closings tc
   where tc.teacher_id = v_teacher
     and tc.month_year = p_month
   for update;

  if found then
    -- Depois que o diretor moveu o fechamento adiante (pagou, aprovou, mandou
    -- para análise de NF), a confirmação do professor já cumpriu o papel.
    -- Reabrir aqui seria voltar o processo no tempo.
    if upper(coalesce(v_row.status, 'PENDENTE'))
       not in ('PENDENTE', 'PENDING', 'PENDING_TEACHER', 'REJEITADO') then
      raise exception using errcode = '42501', message = 'fechamento_ja_em_processamento';
    end if;

    update public.teacher_closings tc
       set teacher_confirmation_status = v_confirm,
           teacher_confirmation_date   = now(),
           teacher_notes               = v_notes,
           updated_at                  = now()
     where tc.id = v_row.id
    returning tc.* into v_row;

  else
    -------------------------------------------------------------------------
    -- Sem linha ainda (professor confirma antes do cron mensal). O valor vem
    -- da RPC canônica — a mesma que a tela lê — e não do que o cliente mandar.
    -------------------------------------------------------------------------
    v_report  := public.get_teacher_closing_report(v_teacher, p_month);
    v_lessons := coalesce((v_report -> 'resumo' ->> 'total_aulas')::int, 0);
    v_amount  := round(coalesce((v_report -> 'resumo' ->> 'valor_total')::numeric, 0), 2);

    insert into public.teacher_closings (
      tenant_id, teacher_id, month_year,
      total_lessons, total_amount, status,
      teacher_confirmation_status, teacher_confirmation_date, teacher_notes,
      created_at, updated_at
    )
    values (
      v_profile.tenant_id, v_teacher, p_month,
      v_lessons, v_amount, 'PENDENTE',
      v_confirm, now(), v_notes,
      now(), now()
    )
    -- Corrida com o cron mensal: se a linha nasceu no meio do caminho, a dele
    -- vale (tem carry-over) e aqui só entra a confirmação.
    on conflict (teacher_id, month_year) do update
       set teacher_confirmation_status = excluded.teacher_confirmation_status,
           teacher_confirmation_date   = excluded.teacher_confirmation_date,
           teacher_notes               = excluded.teacher_notes,
           updated_at                  = now()
    returning * into v_row;

    v_created := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'criado', v_created,
    'id', v_row.id,
    'month_year', v_row.month_year,
    'status', v_row.status,
    'teacher_confirmation_status', v_row.teacher_confirmation_status,
    'total_lessons', v_row.total_lessons,
    'total_amount', v_row.total_amount
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Anexo da nota fiscal
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_attach_invoice(
  p_closing_id uuid,
  p_nf_link text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_teacher uuid := auth.uid();
  v_profile record;
  v_row public.teacher_closings;
  v_link text;
  v_status text;
  v_novo_status text;
begin
  if v_teacher is null or auth.role() <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select p.id, p.tenant_id, p.role
    into v_profile
    from public.profiles p
   where p.id = v_teacher;

  if not found
     or v_profile.tenant_id is null
     or v_profile.role not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;

  v_link := nullif(pg_catalog.btrim(coalesce(p_nf_link, '')), '');
  if v_link is null or pg_catalog.length(v_link) > 2000 then
    raise exception using errcode = '22023', message = 'nf_link_invalido';
  end if;
  -- O link é renderizado como href para o diretor. Espaço/controle e esquema
  -- que não seja http(s) ficam de fora; caminho do storage continua valendo.
  if v_link ~ '[[:space:][:cntrl:]]'
     or (v_link ~ ':' and v_link !~* '^https?://') then
    raise exception using errcode = '22023', message = 'nf_link_invalido';
  end if;

  -- `teacher_id = auth.uid()` no WHERE: não há como anexar NF em fechamento
  -- alheio nem descobrir se o id existe.
  select tc.* into v_row
    from public.teacher_closings tc
   where tc.id = p_closing_id
     and tc.teacher_id = v_teacher
   for update;

  if not found then
    raise exception using errcode = '42501', message = 'fechamento_nao_encontrado';
  end if;

  v_status := upper(coalesce(v_row.status, ''));

  if v_status = 'COMPLETED' then
    raise exception using errcode = '42501', message = 'nf_ja_aprovada';
  end if;

  -- O status só entra na faixa de análise a partir dos estados em que a NF faz
  -- sentido. Fora deles o arquivo é guardado, mas o professor não empurra o
  -- próprio fechamento na fila do pagamento.
  v_novo_status := case
    when v_status in ('PAID_WAITING_NF', 'PAGO', 'PAID', 'REJECTED', 'REJEITADO', 'UNDER_REVIEW')
      then 'UNDER_REVIEW'
    else v_row.status
  end;

  update public.teacher_closings tc
     set nf_link    = v_link,
         status     = v_novo_status,
         updated_at = now()
   where tc.id = v_row.id
  returning tc.* into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'status', v_row.status,
    'nf_link', v_row.nf_link
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Dono e grants
-- ---------------------------------------------------------------------------

-- A migration roda como `supabase_admin`, mas quem deve emprestar o privilégio
-- é `postgres` — dono de teacher_closings e das RPCs vizinhas
-- (log_teacher_classes, get_teacher_closing_report). Como a tabela não está em
-- FORCE ROW LEVEL SECURITY, o dono já passa pela RLS: é o mínimo que basta, e
-- deixar em supabase_admin daria à função poder que ela não usa.
ALTER FUNCTION public.teacher_submit_closing(text, text, text) OWNER TO postgres;
ALTER FUNCTION public.teacher_attach_invoice(uuid, text)       OWNER TO postgres;

REVOKE ALL ON FUNCTION public.teacher_submit_closing(text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.teacher_attach_invoice(uuid, text)       FROM public, anon;
GRANT EXECUTE ON FUNCTION public.teacher_submit_closing(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_attach_invoice(uuid, text)       TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Verificação — a migration falha se sobrar caminho de escrita
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_sobrou text;
BEGIN
  -- Qualquer policy permissiva de INSERT/UPDATE/ALL que NÃO exija papel de
  -- diretor é regressão. O teste é textual de propósito: policy nova que
  -- reabrir o caminho por `auth.uid() = teacher_id` derruba o deploy aqui.
  SELECT string_agg(policyname || ' (' || cmd || ')', ', ')
    INTO v_sobrou
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'teacher_closings'
     AND permissive = 'PERMISSIVE'
     AND cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') NOT LIKE '%_my_role%';

  IF v_sobrou IS NOT NULL THEN
    RAISE EXCEPTION 'teacher_closings ainda tem escrita sem checagem de papel: %', v_sobrou;
  END IF;

  IF has_table_privilege('anon', 'public.teacher_closings', 'UPDATE')
     OR has_table_privilege('anon', 'public.teacher_closings', 'INSERT') THEN
    RAISE EXCEPTION 'anon ainda escreve em teacher_closings';
  END IF;

  IF has_table_privilege('authenticated', 'public.teacher_closings', 'TRUNCATE') THEN
    RAISE EXCEPTION 'TRUNCATE ainda concedido em teacher_closings (não passa por RLS)';
  END IF;

  IF to_regprocedure('public.teacher_submit_closing(text, text, text)') IS NULL
     OR to_regprocedure('public.teacher_attach_invoice(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'RPCs de fechamento do professor não foram criadas';
  END IF;
END
$$;
