-- Ação pendente do assistente do grupo — confirmação em dois passos.
--
-- O diretor quer lançar ajuste de repasse por áudio no grupo. Isso é uma IA
-- gravando valor A PAGAR a partir de uma transcrição, e transcrição erra:
-- "trinta" e "trezentos" são um fonema de distância, e o próprio diretor já
-- falou "setecentos e vinte e seis" querendo dizer setecentos e dezessete.
--
-- Por isso o assistente NÃO grava direto. Ele entende, guarda a intenção aqui,
-- repete em texto o que entendeu e espera um "confirma". Só então executa.
-- O custo é uma mensagem a mais; o benefício é que todo valor errado morre na
-- leitura em voz alta, antes de virar dinheiro.
--
-- Regras que a tabela sustenta:
--   * expira em 5 minutos — intenção velha não pode ser confirmada por engano
--     num "sim" que era resposta a outra coisa;
--   * uma pendência por grupo (PK) — a nova sobrescreve a anterior, então nunca
--     há dúvida sobre o que o "confirma" está confirmando;
--   * guarda quem pediu, para o lançamento ter dono.

CREATE TABLE IF NOT EXISTS public.gestao_acao_pendente (
  group_jid   text PRIMARY KEY,
  tenant_id   text NOT NULL,
  acao        jsonb NOT NULL,
  resumo      text NOT NULL,
  pedido_por  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);

COMMENT ON TABLE public.gestao_acao_pendente IS
  'Intenção do assistente do grupo aguardando confirmação. Uma por grupo, expira em 5 min.';

ALTER TABLE public.gestao_acao_pendente ENABLE ROW LEVEL SECURITY;
-- Sem policy de leitura: só o service_role (a edge) toca nesta tabela.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gestao_acao_pendente TO service_role;

-- Dobra acento sem exigir a extensão `unaccent`, que não está instalada neste
-- banco. IMMUTABLE para poder ser usada em índice se um dia precisar.
CREATE OR REPLACE FUNCTION public.fold_accents(p_txt text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fold$
  SELECT translate(lower(COALESCE(p_txt,'')),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc');
$fold$;

-- Resolve "Lais" / "laís sampaio" para o professor certo do tenant.
-- Devolve erro explícito quando não acha ou quando acha MAIS DE UM: mandar o
-- assistente escolher entre dois professores parecidos é como se paga a pessoa
-- errada.
CREATE OR REPLACE FUNCTION public.gestao_resolve_professor(
  p_tenant text, p_nome text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_n int; v_id uuid; v_nome text; v_termo text;
BEGIN
  v_termo := fold_accents(btrim(COALESCE(p_nome,'')));
  IF v_termo = '' THEN RETURN jsonb_build_object('error','nome_vazio'); END IF;

  SELECT count(*) INTO v_n FROM profiles p
   WHERE p.tenant_id = p_tenant AND p.role = 'TEACHER'
     AND fold_accents(p.full_name) LIKE '%' || v_termo || '%';

  IF v_n = 0 THEN RETURN jsonb_build_object('error','professor_nao_encontrado'); END IF;
  IF v_n > 1 THEN
    RETURN jsonb_build_object('error','nome_ambiguo', 'candidatos', (
      SELECT jsonb_agg(trim(p.full_name)) FROM profiles p
       WHERE p.tenant_id = p_tenant AND p.role = 'TEACHER'
         AND fold_accents(p.full_name) LIKE '%' || v_termo || '%'));
  END IF;

  SELECT p.id, trim(p.full_name) INTO v_id, v_nome FROM profiles p
   WHERE p.tenant_id = p_tenant AND p.role = 'TEACHER'
     AND fold_accents(p.full_name) LIKE '%' || v_termo || '%'
   LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'nome', v_nome);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_resolve_professor(text,text) TO service_role;

-- Executa o ajuste em nome da direção, a partir do grupo autorizado.
-- Teto de valor: erro de transcrição costuma errar a ORDEM DE GRANDEZA, e é
-- exatamente isso que o teto pega. Acima dele, manda para a tela.
CREATE OR REPLACE FUNCTION public.gestao_lanca_ajuste(
  p_tenant text, p_teacher_id uuid, p_month text, p_descricao text,
  p_valor numeric, p_pedido_por text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_sync boolean; v_teto numeric := 500;
BEGIN
  IF COALESCE(current_setting('request.jwt.claims', true)::json->>'role','') <> 'service_role' THEN
    RETURN jsonb_build_object('error','somente_pelo_assistente');
  END IF;
  IF p_month !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;
  IF p_valor IS NULL OR p_valor = 0 THEN RETURN jsonb_build_object('error','valor_invalido'); END IF;
  IF abs(p_valor) > v_teto THEN
    RETURN jsonb_build_object('error','acima_do_teto','teto',v_teto);
  END IF;
  IF COALESCE(btrim(p_descricao),'') = '' THEN RETURN jsonb_build_object('error','motivo_obrigatorio'); END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_teacher_id
                   AND role = 'TEACHER' AND tenant_id = p_tenant) THEN
    RETURN jsonb_build_object('error','professor_invalido');
  END IF;

  INSERT INTO closing_adjustments (tenant_id, teacher_id, month_year, description, amount)
  VALUES (p_tenant, p_teacher_id, p_month,
          btrim(p_descricao) || COALESCE(' [via WhatsApp: ' || p_pedido_por || ']', ' [via WhatsApp]'),
          p_valor)
  RETURNING id INTO v_id;

  UPDATE teacher_closings SET total_amount = total_amount + p_valor, updated_at = now()
   WHERE teacher_id = p_teacher_id AND month_year = p_month AND status = 'PENDENTE';
  v_sync := FOUND;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'repasse_atualizado', v_sync);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.gestao_lanca_ajuste(text,uuid,text,text,numeric,text) TO service_role;
