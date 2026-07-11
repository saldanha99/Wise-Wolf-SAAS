import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// school-admin — Ações administrativas da coordenação (Fase 1 da blindagem).
//   - setStudentLifecycle: active | suspended | offboarded (+ cancela ASAAS)
//   - setTeacherLifecycle: active | suspended | offboarded
//   - serasaNegativar: dispara negativação Serasa de uma cobrança vencida
// Segurança: exige JWT de SCHOOL_ADMIN/SUPER_ADMIN do MESMO tenant do alvo.
// Todo efeito é auditado em audit_logs.
// ============================================================================

let ASAAS_URL = (Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com')
  .replace(/\/+$/, '').replace(/\/v3$/, '').replace(/\/api\/v3$/, '').replace(/\/api$/, '');
const ASAAS_KEY = Deno.env.get('ASAAS_API_KEY') || Deno.env.get('ASAAS_ACCESS_TOKEN');
const ASAAS_PREFIX = (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) ? '/v3' : '/api/v3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const LIFECYCLE = ['active', 'suspended', 'offboarded'];

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
async function asaas(path: string, method = 'GET', payload?: unknown) {
  const r = await fetch(`${ASAAS_URL}${ASAAS_PREFIX}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY! },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const SERVICE = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    // --- Autenticação + autorização ---
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'missing token' }, 401);
    const { data: { user } } = await SERVICE.auth.getUser(jwt);
    if (!user) return json({ error: 'invalid token' }, 401);
    const { data: caller } = await SERVICE.from('profiles').select('id, role, tenant_id').eq('id', user.id).maybeSingle();
    if (!caller || !['SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(caller.role)) return json({ error: 'forbidden' }, 403);

    const body = await req.json();
    const action = body.action as string;
    const ip = req.headers.get('x-forwarded-for') || null;

    async function audit(act: string, rtype: string, rid: string, oldV: unknown, newV: unknown) {
      await SERVICE.from('audit_logs').insert({
        tenant_id: caller!.tenant_id, user_id: caller!.id, user_role: caller!.role,
        action: act, resource_type: rtype, resource_id: rid,
        old_values: oldV, new_values: newV, ip_address: ip,
      });
    }

    // ------------------------------------------------------------------
    // setStudentLifecycle / setTeacherLifecycle
    // ------------------------------------------------------------------
    if (action === 'setStudentLifecycle' || action === 'setTeacherLifecycle') {
      const isStudent = action === 'setStudentLifecycle';
      const targetId = (isStudent ? body.studentId : body.teacherId) as string;
      const status = body.status as string;
      const reason = (body.reason as string) || null;
      const cancelBilling = body.cancelBilling !== false; // default true p/ aluno
      if (!targetId || !LIFECYCLE.includes(status)) return json({ error: 'params invalidos' }, 400);

      const { data: target } = await SERVICE.from('profiles')
        .select('id, role, tenant_id, lifecycle_status, status_financial, subscription_id, full_name')
        .eq('id', targetId).maybeSingle();
      if (!target) return json({ error: 'alvo nao encontrado' }, 404);
      if (target.tenant_id !== caller.tenant_id && caller.role !== 'SUPER_ADMIN') return json({ error: 'outro tenant' }, 403);

      const patch: Record<string, unknown> = { lifecycle_status: status };
      if (status === 'suspended') { patch.suspended_at = new Date().toISOString(); patch.suspended_reason = reason; }
      if (status === 'offboarded') {
        patch.offboarding_status = 'COMPLETED';
        patch.offboarding_completed_at = new Date().toISOString();
        patch.offboarding_reason = reason;
      }
      if (status === 'active') { patch.suspended_at = null; patch.suspended_reason = null; }

      await SERVICE.from('profiles').update(patch).eq('id', targetId);

      // Efeitos de cobrança: ao suspender/desligar ALUNO, parar de gerar mensalidade.
      const billing: unknown[] = [];
      if (isStudent && cancelBilling && status !== 'active') {
        if (target.subscription_id) {
          const r = await asaas(`/subscriptions/${target.subscription_id}`, 'DELETE');
          billing.push({ cancelSubscription: target.subscription_id, status: r.status, data: r.data });
        }
        if (status === 'offboarded') {
          // anula faturas FUTURAS (não vencidas) — dívida vencida fica para cobrança
          const today = new Date().toISOString().split('T')[0];
          const { data: future } = await SERVICE.from('student_payments')
            .select('id, asaas_payment_id, asaas_id')
            .eq('student_id', targetId).eq('status', 'PENDING').gte('due_date', today);
          for (const f of (future || [])) {
            const pid = f.asaas_payment_id || f.asaas_id;
            if (pid) { const r = await asaas(`/payments/${pid}`, 'DELETE'); billing.push({ deletePayment: pid, status: r.status }); }
            await SERVICE.from('student_payments').update({ status: 'CANCELLED', updated_at: new Date().toISOString() }).eq('id', f.id);
          }
        }
      }

      await audit(action, isStudent ? 'student' : 'teacher', targetId,
        { lifecycle_status: target.lifecycle_status }, { lifecycle_status: status, reason, billing });

      return json({ ok: true, id: targetId, lifecycle_status: status, billing });
    }

    // ------------------------------------------------------------------
    // serasaNegativar — dispara negativação Serasa de uma cobrança no ASAAS
    // ------------------------------------------------------------------
    if (action === 'serasaNegativar') {
      const paymentId = body.paymentId as string; // pay_...
      if (!paymentId) return json({ error: 'paymentId obrigatorio' }, 400);

      const { data: pay } = await SERVICE.from('student_payments')
        .select('id, student_id, tenant_id, value, asaas_payment_id, asaas_id')
        .or(`asaas_payment_id.eq.${paymentId},asaas_id.eq.${paymentId}`).maybeSingle();
      if (!pay) return json({ error: 'cobranca nao encontrada' }, 404);
      if (pay.tenant_id !== caller.tenant_id && caller.role !== 'SUPER_ADMIN') return json({ error: 'outro tenant' }, 403);

      const { data: stu } = await SERVICE.from('profiles')
        .select('full_name, cpf, phone, postal_code, address, address_number')
        .eq('id', pay.student_id).maybeSingle();

      const dunning = {
        type: 'SERASA',
        paymentId,
        description: 'Cobranca de debito em aberto',
        customerName: stu?.full_name,
        customerCpfCnpj: (stu?.cpf || '').replace(/\D/g, ''),
        customerPrimaryPhone: (stu?.phone || '').replace(/\D/g, ''),
        customerPostalCode: (stu?.postal_code || '').replace(/\D/g, ''),
        customerAddress: stu?.address,
        customerAddressNumber: stu?.address_number,
      };
      const r = await asaas('/paymentDunnings', 'POST', dunning);
      await audit('serasaNegativar', 'payment', paymentId, null, { status: r.status, data: r.data });
      return json({ ok: r.status < 300, asaas_status: r.status, data: r.data });
    }

    return json({ error: 'action invalida' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
