-- Medição de consumo do modo de voz ao vivo (OpenAI Realtime).
--
-- Motivo: até agora nada registrava quanto uma conversa ao vivo custava. Não
-- havia como responder "quanto o aluno X gastou este mês", nem aplicar cota.
-- O Realtime recobra a conversa acumulada como input a cada turno, então o
-- custo cresce de forma não-linear e precisa ser observado por turno.
--
-- Áudio custa muito mais que texto e o cache é bem mais barato que o input
-- normal, por isso cada categoria fica em coluna própria: um total agregado
-- esconderia exatamente a informação que permite reduzir a conta.

ALTER TABLE public.wolfie_turns
  ADD COLUMN IF NOT EXISTS usage_input_text_tokens integer,
  ADD COLUMN IF NOT EXISTS usage_input_audio_tokens integer,
  ADD COLUMN IF NOT EXISTS usage_output_text_tokens integer,
  ADD COLUMN IF NOT EXISTS usage_output_audio_tokens integer,
  ADD COLUMN IF NOT EXISTS usage_cached_tokens integer;

COMMENT ON COLUMN public.wolfie_turns.usage_input_audio_tokens IS
  'Tokens de áudio de entrada cobrados neste turno (categoria mais cara).';
COMMENT ON COLUMN public.wolfie_turns.usage_cached_tokens IS
  'Parcela do input servida pelo cache da OpenAI (bem mais barata).';

-- Só turnos do Realtime carregam consumo; o modo clássico não usa a OpenAI.
CREATE INDEX IF NOT EXISTS idx_wolfie_turns_realtime_usage
  ON public.wolfie_turns (session_id, created_at)
  WHERE source_kind = 'openai_realtime';

-- Grava o consumo no turno do assistente JÁ inserido por
-- record_wolfie_realtime_exchange. Deliberadamente separado daquela RPC: ela
-- concentra idempotência, lock de sessão e alocação de turn_index, e não vale
-- arriscar esse miolo por uma coluna de métrica. Se esta falhar, a conversa
-- do aluno segue intacta — só o número não é contabilizado.
CREATE OR REPLACE FUNCTION public.record_wolfie_realtime_usage(
  p_session_id uuid,
  p_client_turn_id uuid,
  p_usage jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated int := 0;
  v_int  int;
BEGIN
  IF p_session_id IS NULL OR p_client_turn_id IS NULL
     OR p_usage IS NULL OR jsonb_typeof(p_usage) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Valor negativo ou não-numérico vira NULL em vez de sujar o relatório.
  v_int := NULLIF(GREATEST((p_usage->>'totalTokens')::numeric, 0), 0)::int;

  UPDATE public.wolfie_turns t
     SET tokens_used = COALESCE(v_int, t.tokens_used),
         usage_input_text_tokens =
           GREATEST((p_usage->>'inputTextTokens')::numeric, 0)::int,
         usage_input_audio_tokens =
           GREATEST((p_usage->>'inputAudioTokens')::numeric, 0)::int,
         usage_output_text_tokens =
           GREATEST((p_usage->>'outputTextTokens')::numeric, 0)::int,
         usage_output_audio_tokens =
           GREATEST((p_usage->>'outputAudioTokens')::numeric, 0)::int,
         usage_cached_tokens =
           GREATEST((p_usage->>'cachedTokens')::numeric, 0)::int
   WHERE t.session_id = p_session_id
     AND t.client_turn_id = p_client_turn_id
     AND t.speaker = 'assistant'
     AND t.source_kind = 'openai_realtime';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_updated > 0, 'updated', v_updated);
EXCEPTION WHEN others THEN
  -- Métrica nunca derruba a aula.
  RETURN jsonb_build_object('ok', false, 'reason', 'usage_write_failed');
END;
$$;

REVOKE ALL ON FUNCTION
  public.record_wolfie_realtime_usage(uuid, uuid, jsonb) FROM public;

-- Relatório de custo por aluno no mês. Só admin/coordenador do próprio tenant.
CREATE OR REPLACE FUNCTION public.wolfie_realtime_usage_report(
  p_month text DEFAULT NULL
)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  sessions int,
  turns int,
  input_audio_tokens bigint,
  output_audio_tokens bigint,
  input_text_tokens bigint,
  output_text_tokens bigint,
  cached_tokens bigint,
  total_tokens bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_role   text;
  v_start  date;
BEGIN
  SELECT p.tenant_id, p.role INTO v_tenant, v_role
  FROM profiles p WHERE p.id = auth.uid();

  IF v_role IS NULL OR v_role NOT IN
     ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;

  -- Mês no formato YYYY-MM; default = mês corrente.
  v_start := date_trunc('month',
    COALESCE(to_date(NULLIF(p_month, ''), 'YYYY-MM'), current_date))::date;

  RETURN QUERY
  SELECT
    s.student_id,
    COALESCE(pr.full_name, '?')::text,
    count(DISTINCT s.id)::int,
    count(t.id)::int,
    COALESCE(sum(t.usage_input_audio_tokens), 0)::bigint,
    COALESCE(sum(t.usage_output_audio_tokens), 0)::bigint,
    COALESCE(sum(t.usage_input_text_tokens), 0)::bigint,
    COALESCE(sum(t.usage_output_text_tokens), 0)::bigint,
    COALESCE(sum(t.usage_cached_tokens), 0)::bigint,
    COALESCE(sum(t.tokens_used), 0)::bigint
  FROM wolfie_turns t
  JOIN wolfie_sessions s ON s.id = t.session_id
  LEFT JOIN profiles pr ON pr.id = s.student_id
  WHERE t.source_kind = 'openai_realtime'
    AND pr.tenant_id = v_tenant
    AND t.created_at >= v_start
    AND t.created_at < (v_start + interval '1 month')
  GROUP BY s.student_id, pr.full_name
  ORDER BY 10 DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.wolfie_realtime_usage_report(text) FROM public;
GRANT EXECUTE ON FUNCTION public.wolfie_realtime_usage_report(text)
  TO authenticated;
