-- O motivo da rejeição da nota fiscal não existia.
--
-- `InvoiceReviewModal.handleReject` gravava `rejection_reason` em
-- teacher_closings desde sempre — coluna que só existe em `profiles` (rejeição
-- de documento do aluno). O UPDATE inteiro falhava, então **nenhuma rejeição de
-- NF jamais foi registrada**: o diretor escrevia o motivo, clicava, via "Erro ao
-- rejeitar nota fiscal" e a nota continuava no mesmo status.
--
-- Efeito no professor: a tela dele mostra "Nota Rejeitada" e um botão vermelho
-- "Reenviar Nota", e **nenhum motivo em lugar nenhum** — ele reenviava a mesma
-- nota errada, porque ninguém disse o que estava errado.
--
-- ⚠️ Não reaproveitei `admin_notes`: essa coluna é usada pelo relatório do
--    diretor (TeacherActivityReport grava observação livre do mês ali) e é
--    exibida ao professor como recado do fechamento. Enfiar o motivo da
--    rejeição junto faria um sobrescrever o outro.

\set ON_ERROR_STOP on

alter table public.teacher_closings
  add column if not exists rejection_reason text;

-- A rejeição é escrita pelo diretor, que já passa por
-- `teacher_closings_tenant_admin`. Não há RPC nova aqui: o que faltava era a
-- coluna, não permissão.

-- ---------------------------------------------------------------------------
-- O reenvio limpa o motivo antigo
-- ---------------------------------------------------------------------------
--
-- Sem isto, o professor manda a nota corrigida, o fechamento volta para
-- UNDER_REVIEW e o motivo da rejeição ANTERIOR fica pendurado na tela — ele
-- leria "sua nota foi rejeitada porque..." sobre uma nota que já substituiu.

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
         -- Nota nova, motivo velho não vale mais.
         rejection_reason = case when v_novo_status = 'UNDER_REVIEW'
                                 then null else tc.rejection_reason end,
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

ALTER FUNCTION public.teacher_attach_invoice(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.teacher_attach_invoice(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.teacher_attach_invoice(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Verificação
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teacher_closings'
       AND column_name = 'rejection_reason'
  ) THEN
    RAISE EXCEPTION 'rejection_reason nao foi criada em teacher_closings';
  END IF;

  IF position('rejection_reason' IN
       (SELECT pg_get_functiondef(oid) FROM pg_proc
         WHERE proname = 'teacher_attach_invoice')) = 0 THEN
    RAISE EXCEPTION 'teacher_attach_invoice nao limpa o motivo da rejeicao';
  END IF;
END
$$;
