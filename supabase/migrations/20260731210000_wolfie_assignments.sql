-- Tarefa do Wolfie prescrita pelo professor.
--
-- O número que motiva isto: a escola deu 274 aulas em julho e apenas 9 de 52
-- alunos usaram o Wolfie no mês — com o uso caindo 74% desde maio enquanto as
-- aulas subiam 91%. O gargalo nunca foi custo nem capacidade: é que ninguém
-- diz ao aluno para praticar.
--
-- A aula é o único momento em que escola e aluno já estão em contato. Se o
-- professor sai da aula prescrevendo um tema, o Wolfie deixa de depender de o
-- aluno lembrar sozinho de abrir o app.

CREATE TABLE IF NOT EXISTS public.wolfie_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  student_id   uuid NOT NULL,
  teacher_id   uuid NOT NULL,
  class_log_id uuid,
  topic        text NOT NULL,
  note         text,
  status       text NOT NULL DEFAULT 'PENDING',
  sent_at      timestamptz,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Data já resolvida no fuso da escola: `created_at::date` não é IMMUTABLE
  -- (depende de timezone) e por isso não pode entrar em índice.
  assigned_on  date NOT NULL
    DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date),
  CONSTRAINT wolfie_assignments_status_check
    CHECK (status IN ('PENDING', 'STARTED', 'DONE', 'CANCELLED'))
);

-- Idempotência real: se a tabela já existir de uma execução anterior, o
-- CREATE TABLE IF NOT EXISTS não adiciona colunas novas.
ALTER TABLE public.wolfie_assignments
  ADD COLUMN IF NOT EXISTS assigned_on date NOT NULL
    DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date);

CREATE INDEX IF NOT EXISTS idx_wolfie_assignments_student
  ON public.wolfie_assignments (student_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wolfie_assignments_teacher
  ON public.wolfie_assignments (teacher_id, created_at DESC);

-- Uma tarefa pendente por aluno por dia: o professor lança várias aulas de uma
-- vez e não pode acabar mandando três WhatsApps para o mesmo aluno.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wolfie_assignment_daily
  ON public.wolfie_assignments (student_id, assigned_on)
  WHERE status = 'PENDING';

ALTER TABLE public.wolfie_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_read_own ON public.wolfie_assignments;
CREATE POLICY wa_read_own ON public.wolfie_assignments
  FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR teacher_id = auth.uid());

-- Professor prescreve. Devolve jsonb com o telefone para o cliente disparar o
-- WhatsApp pela instância dele, como já faz nos outros avisos de aula.
CREATE OR REPLACE FUNCTION public.assign_wolfie_task(
  p_student_id uuid,
  p_topic text,
  p_note text DEFAULT NULL,
  p_class_log_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role     text;
  v_tenant   text;
  v_student  record;
  v_id       uuid;
  v_topic    text := left(btrim(COALESCE(p_topic, '')), 120);
BEGIN
  SELECT p.role, p.tenant_id INTO v_role, v_tenant
  FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN
     ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;
  IF v_topic = '' THEN
    RAISE EXCEPTION 'tema_obrigatorio';
  END IF;

  SELECT p.id, p.full_name, p.phone, p.tenant_id, p.status, p.status_financial
    INTO v_student
  FROM public.profiles p
  WHERE p.id = p_student_id AND p.role = 'STUDENT';
  IF v_student.id IS NULL OR v_student.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'aluno_invalido';
  END IF;

  -- Aluno inativo não recebe automação; a mesma regra do resto do sistema.
  IF NOT public.is_student_notifiable(p_student_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'aluno_inativo');
  END IF;

  INSERT INTO public.wolfie_assignments
    (tenant_id, student_id, teacher_id, class_log_id, topic, note)
  VALUES (v_tenant, p_student_id, auth.uid(), p_class_log_id, v_topic,
          left(btrim(COALESCE(p_note, '')), 300))
  ON CONFLICT (student_id, assigned_on)
    WHERE status = 'PENDING' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'duplicada', true,
                              'reason', 'ja_tem_tarefa_hoje');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'id', v_id, 'topic', v_topic,
    'student_name', v_student.full_name, 'student_phone', v_student.phone
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_wolfie_task(uuid, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION
  public.assign_wolfie_task(uuid, text, text, uuid) TO authenticated;

-- Marca que o WhatsApp saiu, para o professor ver o que já foi enviado.
CREATE OR REPLACE FUNCTION public.mark_wolfie_assignment_sent(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.wolfie_assignments
  SET sent_at = now()
  WHERE id = p_id AND teacher_id = auth.uid();
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_wolfie_assignment_sent(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_wolfie_assignment_sent(uuid) TO authenticated;

-- O aluno lê a própria tarefa pendente (alimenta o início em um toque).
CREATE OR REPLACE FUNCTION public.my_wolfie_assignment()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row record;
BEGIN
  SELECT a.id, a.topic, a.note, a.created_at, p.full_name AS teacher_name
    INTO v_row
  FROM public.wolfie_assignments a
  LEFT JOIN public.profiles p ON p.id = a.teacher_id
  WHERE a.student_id = auth.uid() AND a.status = 'PENDING'
  ORDER BY a.created_at DESC LIMIT 1;

  IF v_row.id IS NULL THEN RETURN jsonb_build_object('has', false); END IF;
  RETURN jsonb_build_object(
    'has', true, 'id', v_row.id, 'topic', v_row.topic, 'note', v_row.note,
    'teacher_name', v_row.teacher_name, 'created_at', v_row.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.my_wolfie_assignment() FROM public;
GRANT EXECUTE ON FUNCTION public.my_wolfie_assignment() TO authenticated;

-- O aluno marca que começou/terminou. É isto que fecha o laço e permite medir
-- se a prescrição do professor realmente converte em prática.
CREATE OR REPLACE FUNCTION public.advance_wolfie_assignment(
  p_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_next text := upper(btrim(COALESCE(p_status, '')));
BEGIN
  IF v_next NOT IN ('STARTED', 'DONE') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'status_invalido');
  END IF;

  UPDATE public.wolfie_assignments
  SET status = v_next,
      started_at = COALESCE(started_at,
        CASE WHEN v_next IN ('STARTED', 'DONE') THEN now() END),
      completed_at = CASE WHEN v_next = 'DONE' THEN now() ELSE completed_at END
  WHERE id = p_id AND student_id = auth.uid() AND status <> 'DONE';

  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION
  public.advance_wolfie_assignment(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION
  public.advance_wolfie_assignment(uuid, text) TO authenticated;

-- Conversão da prescrição: quantas viraram prática de verdade.
CREATE OR REPLACE FUNCTION public.wolfie_assignment_stats(
  p_month text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role   text;
  v_tenant text;
  v_start  date;
  v_out    jsonb;
BEGIN
  SELECT p.role, p.tenant_id INTO v_role, v_tenant
  FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN
     ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;

  v_start := date_trunc('month',
    COALESCE(to_date(NULLIF(p_month, ''), 'YYYY-MM'), current_date))::date;

  SELECT jsonb_build_object(
    'prescritas', count(*),
    'enviadas',   count(*) FILTER (WHERE sent_at IS NOT NULL),
    'iniciadas',  count(*) FILTER (WHERE started_at IS NOT NULL),
    'concluidas', count(*) FILTER (WHERE status = 'DONE'),
    'alunos',     count(DISTINCT student_id)
  ) INTO v_out
  FROM public.wolfie_assignments
  WHERE tenant_id = v_tenant
    AND created_at >= v_start
    AND created_at < (v_start + interval '1 month');

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.wolfie_assignment_stats(text) FROM public;
GRANT EXECUTE ON FUNCTION public.wolfie_assignment_stats(text) TO authenticated;
