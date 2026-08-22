import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadTenantCentralWhatsAppInstance } from "../_shared/tenant-communication.ts";

// ============================================================================
// coverage-admin — Substituição temporária de aula (Fase 2).
//   createAbsence : registra ausência do professor e lista as aulas afetadas
//   requestCoverage: cria coberturas (handshake via WhatsApp) ou força executor
//   listCoverages : coberturas de uma ausência
// O cover_teacher_id (executor) é quem recebe; o titular fica intacto.
// Admin-only (SCHOOL_ADMIN/SUPER_ADMIN, mesmo tenant).
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const EVOLUTION_API_BASE = 'https://api.2b.app.br/message/sendText';
// Chave via env para permitir rotação sem novo deploy.
const EVOLUTION_TOKENS = Array.from(new Set([
  (Deno.env.get('EVOLUTION_API_KEY') || '').trim(),
].filter(Boolean)));
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

// dia da semana (texto PT do bookings) -> número (0=domingo)
const DOW: Record<string, number> = { 'Domingo': 0, 'Segunda': 1, 'Terça': 2, 'Quarta': 3, 'Quinta': 4, 'Sexta': 5, 'Sábado': 6 };

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const S = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'missing token' }, 401);
    const { data: { user } } = await S.auth.getUser(jwt);
    if (!user) return json({ error: 'invalid token' }, 401);
    const { data: caller } = await S.from('profiles').select('id, role, tenant_id').eq('id', user.id).maybeSingle();
    if (!caller || !['SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(caller.role)) return json({ error: 'forbidden' }, 403);

    const body = await req.json();
    const action = body.action as string;

    // -------- createAbsence --------
    if (action === 'createAbsence') {
      const { teacherId, startsAt, endsAt, reason } = body;
      if (!teacherId || !startsAt || !endsAt) return json({ error: 'params invalidos' }, 400);

      const { data: absence, error: aerr } = await S.from('teacher_absences').insert({
        teacher_id: teacherId, tenant_id: caller.tenant_id, starts_at: startsAt, ends_at: endsAt,
        reason: reason || null, status: 'active',
      }).select().single();
      if (aerr) return json({ error: aerr.message }, 400);

      // bookings recorrentes do professor (sem data fixa)
      const { data: bookings } = await S.from('bookings')
        .select('id, student_id, day_of_week, time_slot, profiles!bookings_student_id_fkey(full_name)')
        .eq('teacher_id', teacherId).eq('tenant_id', caller.tenant_id);

      // expande dia-da-semana -> datas dentro do período
      const classes: any[] = [];
      const start = new Date(startsAt + 'T00:00:00');
      const end = new Date(endsAt + 'T00:00:00');
      for (const b of (bookings || [])) {
        const dow = DOW[(b as any).day_of_week];
        if (dow === undefined) continue;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          if (d.getDay() === dow) {
            const prof = Array.isArray((b as any).profiles) ? (b as any).profiles[0] : (b as any).profiles;
            classes.push({
              bookingId: (b as any).id, studentId: (b as any).student_id,
              studentName: prof?.full_name || 'Aluno',
              classDate: d.toISOString().split('T')[0],
              classTime: (b as any).time_slot, dow,
            });
          }
        }
      }
      classes.sort((a, b) => (a.classDate + a.classTime).localeCompare(b.classDate + b.classTime));
      return json({ ok: true, absence, classes });
    }

    // -------- requestCoverage (handshake) ou force --------
    if (action === 'requestCoverage') {
      const { absenceId, items, mode } = body; // items: [{bookingId, studentId, classDate, classTime, coverTeacherId}]
      if (!absenceId || !Array.isArray(items) || !items.length) return json({ error: 'params invalidos' }, 400);
      const { data: absence } = await S.from('teacher_absences').select('*').eq('id', absenceId).maybeSingle();
      if (!absence || (absence.tenant_id !== caller.tenant_id && caller.role !== 'SUPER_ADMIN')) return json({ error: 'absence invalida' }, 404);

      // instância central p/ WhatsApp
      let instance: string | null = null;
      if (mode !== 'force') {
        instance = await loadTenantCentralWhatsAppInstance(S, absence.tenant_id);
      }

      const out: any[] = [];
      for (const it of items) {
        const isForce = mode === 'force';
        const token = isForce ? null : crypto.randomUUID().replace(/-/g, '');
        const { data: cov, error: cerr } = await S.from('class_coverages').insert({
          original_teacher_id: absence.teacher_id, cover_teacher_id: it.coverTeacherId, student_id: it.studentId,
          booking_id: it.bookingId, absence_id: absenceId, tenant_id: caller.tenant_id,
          class_date: it.classDate, class_time: it.classTime,
          status: isForce ? 'confirmed' : 'pending', token,
          notes: isForce ? 'Forçado pela coordenação' : null,
          confirmed_at: isForce ? new Date().toISOString() : null,
          dispatched_at: isForce ? null : new Date().toISOString(),
        }).select().single();
        if (cerr) { out.push({ item: it, error: cerr.message }); continue; }

        // dispara WhatsApp de aceite ao substituto
        if (!isForce && instance && token) {
          const { data: cover } = await S.from('profiles').select('full_name, phone').eq('id', it.coverTeacherId).maybeSingle();
          let phone = (cover?.phone || '').replace(/\D/g, '');
          if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
          if (phone.length >= 12) {
            const link = `${SUPABASE_URL}/functions/v1/accept-coverage?token=${token}`;
            const nome = (cover?.full_name || '').split(' ')[0];
            const dataFmt = new Date(it.classDate + 'T00:00:00').toLocaleDateString('pt-BR');
            const text = `Olá ${nome}! 🐺\n\nA coordenação precisa de uma *cobertura de aula*:\n\n📅 ${dataFmt} às *${it.classTime}*\n👤 Aluno: ${it.studentName || ''}\n\nConsegue cobrir? Confirme aqui:\n${link}`;
            try {
              for (const key of EVOLUTION_TOKENS) {
                const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
                  body: JSON.stringify({ number: phone, text, delay: 600, linkPreview: false }),
                });
                if (resp.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
              }
            } catch (_e) { /* envio é melhor-esforço; a cobertura fica pendente no painel */ }
          }
        }
        out.push({ coverage: cov });
      }
      await S.from('audit_logs').insert({
        tenant_id: caller.tenant_id, user_id: caller.id, user_role: caller.role,
        action: mode === 'force' ? 'coverage_force' : 'coverage_request', resource_type: 'absence', resource_id: absenceId,
        new_values: { count: out.length },
      });
      return json({ ok: true, results: out });
    }

    // -------- listCoverages --------
    if (action === 'listCoverages') {
      const { absenceId } = body;
      const { data } = await S.from('class_coverages').select('*').eq('absence_id', absenceId).order('class_date');
      return json({ ok: true, coverages: data || [] });
    }

    return json({ error: 'action invalida' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
