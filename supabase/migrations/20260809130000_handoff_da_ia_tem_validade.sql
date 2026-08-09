-- O handoff humano ganha data — e volta atrás.
--
-- Medido em produção (09/08/2026): a Michelle recebeu 132 mensagens em 30 dias e
-- respondeu 12. As outras 120 foram descartadas com `skipped: human_handoff`.
-- 26 das 67 candidaturas e 34 dos 103 leads estão com `ai_handoff = true`.
--
-- O handoff foi desenhado para "a IA sai de cena NESTA conversa" quando um humano
-- responde manualmente pela instância central. Só que era booleano e sem volta:
-- uma única resposta manual calava a IA naquele contato PARA SEMPRE. Não havia
-- expiração, botão de desfazer, nem aviso — a base foi emudecendo em silêncio.
--
-- `ai_handoff_at` é o carimbo do momento em que o humano assumiu. Com ele o
-- inbound pode decidir "isto ainda é um atendimento humano vivo?" em vez de
-- "alguém já respondeu aqui alguma vez na história?".
--
-- ⚠️ A expiração vale só para o caminho REATIVO (o contato escreveu de novo e a
-- IA pode responder). A prospecção ativa (`sdr-followups`) continua exigindo
-- `ai_handoff = false`: se um humano assumiu o contato, o robô não volta a
-- CUTUCAR sozinho — no máximo volta a atender quem procurou.
--
-- Re-executável: `if not exists`, `create or replace`, sem begin/commit.

alter table public.crm_leads
  add column if not exists ai_handoff_at timestamptz;

alter table public.job_applications
  add column if not exists ai_handoff_at timestamptz;

-- Backfill: quem já está mudo recebe como carimbo a ÚLTIMA mensagem trocada com
-- ele. Usar now() aqui prorrogaria o silêncio por mais uma janela inteira, o que
-- é exatamente o problema que esta migration existe para acabar. Sem histórico,
-- cai no created_at do registro.
update public.crm_leads l
   set ai_handoff_at = coalesce(
         (select max(m.created_at) from public.ai_wa_messages m
           where m.tenant_id = l.tenant_id and m.phone = l.phone),
         l.last_outbound_at, l.created_at, now())
 where l.ai_handoff is true and l.ai_handoff_at is null;

update public.job_applications a
   set ai_handoff_at = coalesce(
         (select max(m.created_at) from public.ai_wa_messages m
           where m.meta ->> 'application_id' = a.id::text),
         a.created_at, now())
 where a.ai_handoff is true and a.ai_handoff_at is null;

-- Devolver o contato à IA (ou tirar dela) pela tela.
--
-- `p_kind` é 'lead' ou 'candidato'. Escrever direto na tabela pelo PostgREST
-- exigiria policy de update ampla nas duas; uma RPC estreita mantém a escrita
-- fechada e deixa a decisão auditável num lugar só.
create or replace function public.set_ai_handoff(
  p_kind text,
  p_id uuid,
  p_handoff boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_tenant text;
  v_row_tenant text;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if v_role is null or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  if p_kind = 'lead' then
    select tenant_id into v_row_tenant from crm_leads where id = p_id;
    if v_row_tenant is null then return jsonb_build_object('ok', false, 'error', 'nao_encontrado'); end if;
    if v_row_tenant <> v_tenant and v_role <> 'SUPER_ADMIN' then
      return jsonb_build_object('ok', false, 'error', 'outro_tenant');
    end if;
    update crm_leads
       set ai_handoff = coalesce(p_handoff, false),
           ai_handoff_at = case when coalesce(p_handoff, false) then now() else null end
     where id = p_id;

  elsif p_kind = 'candidato' then
    select tenant_id into v_row_tenant from job_applications where id = p_id;
    if v_row_tenant is null then return jsonb_build_object('ok', false, 'error', 'nao_encontrado'); end if;
    if v_row_tenant <> v_tenant and v_role <> 'SUPER_ADMIN' then
      return jsonb_build_object('ok', false, 'error', 'outro_tenant');
    end if;
    update job_applications
       set ai_handoff = coalesce(p_handoff, false),
           ai_handoff_at = case when coalesce(p_handoff, false) then now() else null end
     where id = p_id;

  else
    return jsonb_build_object('ok', false, 'error', 'kind_invalido');
  end if;

  return jsonb_build_object('ok', true, 'handoff', coalesce(p_handoff, false));
end;
$function$;

alter function public.set_ai_handoff(text, uuid, boolean) owner to postgres;
grant execute on function public.set_ai_handoff(text, uuid, boolean) to authenticated;
