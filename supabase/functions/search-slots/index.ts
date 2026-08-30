/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// search-slots — quem tem ESTE horário livre.
//
// Alimenta o botão "Substitutos" da cobertura de aula (AbsenceCoverageManager).
//
// ⚠️ A versão anterior devolvia lista VAZIA em 100% das chamadas, e por isso a
// transferência de aula para outro professor era inalcançável desde sempre
// (`teacher_absences` estava com 0 linhas em produção). Duas causas:
//
//  1. Filtrava disponibilidade como INTERVALO (`start_time <= t AND end_time > t`),
//     mas `teacher_availability.end_time` é NULL nas 322 linhas do banco — o
//     modelo real é SLOT DISCRETO de 30 min, sem fim. Em SQL, `NULL > '15:30'`
//     não é falso, é NULL: a linha nunca entra no resultado.
//     Medido: a query antiga devolvia 0 professores para Terça 15:30; o slot
//     discreto devolve 3.
//  2. Não tinha autenticação NENHUMA e rodava com service role, devolvendo
//     nome e TELEFONE de professor de qualquer escola para quem tivesse a chave
//     anon. Agora exige JWT e escopa pelo tenant de quem chamou.
//
// A cobertura só é honesta se o substituto estiver mesmo livre, então o conflito
// é checado em três frentes: aula fixa (booking recorrente), aula avulsa daquela
// data e reposição já marcada naquela data.
// ============================================================================

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DAY_MAP: Record<number, string> = {
    0: 'Domingo', 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado',
};

// 'HH:MM', 'HH:MM:SS' e 'H:MM' viram sempre 'HH:MM'. O banco guarda `time`
// (HH:MM:SS) na disponibilidade e texto 'HH:MM' em bookings.time_slot — comparar
// os dois sem normalizar já mascarou conflito.
function hhmm(raw: unknown): string | null {
    const m = String(raw ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const S = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // ── Autenticação: quem pergunta define o tenant ──
        const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
        if (!jwt) return json({ error: 'missing token', slots: [] }, 401);
        const { data: { user } } = await S.auth.getUser(jwt);
        if (!user) return json({ error: 'invalid token', slots: [] }, 401);
        const { data: caller } = await S.from('profiles')
            .select('id, role, tenant_id').eq('id', user.id).maybeSingle();
        if (!caller || !['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'DIRECTOR'].includes(caller.role)) {
            return json({ error: 'forbidden', slots: [] }, 403);
        }

        const payload = await req.json().catch(() => ({}));
        const day = Number(payload.day ?? payload.target_day);
        const time = hhmm(payload.time ?? payload.target_time);
        // Data concreta da aula a cobrir. Sem ela dá para checar só a agenda
        // fixa; com ela dá para checar também o que é daquele dia específico.
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date ?? '')) ? String(payload.date) : null;
        const excludeTeacherId = payload.excludeTeacherId ? String(payload.excludeTeacherId) : null;

        if (!Number.isInteger(day) || day < 0 || day > 6 || !time) {
            return json({ error: "parâmetros inválidos: 'day' (0-6) e 'time' (HH:MM)", slots: [] }, 400);
        }

        const dayString = DAY_MAP[day];

        // ── 1. Disponibilidade do dia, no tenant de quem chamou ──
        const { data: availabilities, error: availError } = await S
            .from('teacher_availability')
            .select('teacher_id, start_time, end_time, profiles(full_name, phone, role, lifecycle_status)')
            .eq('day_of_week', day)
            .eq('tenant_id', caller.tenant_id);

        if (availError) return json({ error: 'Availability DB Error: ' + availError.message, slots: [] }, 500);

        // O slot cobre o horário pedido? Com `end_time` preenchido vale o
        // intervalo; sem ele (o caso real hoje) vale o slot exato. Manter os dois
        // caminhos evita que preencher `end_time` um dia quebre a busca de novo.
        const covers = (a: { start_time: unknown; end_time: unknown }): boolean => {
            const start = hhmm(a.start_time);
            if (!start) return false;
            const end = hhmm(a.end_time);
            return end ? (start <= time && time < end) : start === time;
        };

        const seen = new Set<string>();
        const candidates = (availabilities || []).filter((a: any) => {
            if (!a.teacher_id || a.teacher_id === excludeTeacherId) return false;
            if (!covers(a)) return false;
            const p = Array.isArray(a.profiles) ? a.profiles[0] : a.profiles;
            // Professor desligado ou suspenso não pode receber aula de cobertura.
            if (!p || ['offboarded', 'suspended'].includes(String(p.lifecycle_status || ''))) return false;
            if (seen.has(a.teacher_id)) return false; // slots duplicados no cadastro
            seen.add(a.teacher_id);
            return true;
        });

        if (candidates.length === 0) return json({ slots: [] });

        const teacherIds = candidates.map((a: any) => a.teacher_id);
        const busy = new Set<string>();

        // ── 2a. Aula fixa no mesmo dia/horário (CANCELLED não ocupa) ──
        const { data: fixed, error: fixedErr } = await S
            .from('bookings')
            .select('teacher_id, time_slot')
            .eq('tenant_id', caller.tenant_id)
            .in('teacher_id', teacherIds)
            .eq('day_of_week', dayString)
            .neq('status', 'CANCELLED');
        if (fixedErr) return json({ error: 'Booking DB Error: ' + fixedErr.message, slots: [] }, 500);
        for (const b of (fixed || [])) if (hhmm(b.time_slot) === time) busy.add(b.teacher_id);

        // ── 2b. Aula avulsa e reposição daquela data ──
        if (date) {
            const [avulsas, repos] = await Promise.all([
                S.from('bookings').select('teacher_id, time_slot')
                    .eq('tenant_id', caller.tenant_id).in('teacher_id', teacherIds)
                    .eq('date', date).neq('status', 'CANCELLED'),
                S.from('reschedules').select('teacher_id, time')
                    .eq('tenant_id', caller.tenant_id).in('teacher_id', teacherIds)
                    .eq('date', date).is('used_at', null),
            ]);
            for (const b of (avulsas.data || [])) if (hhmm(b.time_slot) === time) busy.add(b.teacher_id);
            for (const r of (repos.data || [])) if (hhmm(r.time) === time) busy.add(r.teacher_id);
        }

        const slots = candidates
            .filter((a: any) => !busy.has(a.teacher_id))
            .map((a: any) => {
                const p = Array.isArray(a.profiles) ? a.profiles[0] : a.profiles;
                const name = p?.full_name || 'Professor';
                const isoDate = date || nextDateFor(day);
                return {
                    teacher_id: a.teacher_id,
                    teacher_name: name,
                    teacher_avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`,
                    teacher_phone: p?.phone ?? null,
                    day: dayString,
                    time,
                    date: isoDate,
                    iso_start: `${isoDate}T${time}`,
                };
            })
            .sort((a, b) => a.teacher_name.localeCompare(b.teacher_name, 'pt-BR'));

        return json({ slots });
    } catch (error: any) {
        // 200 de propósito: a tela trata lista vazia, mas o campo `error` precisa
        // chegar — foi justamente o silêncio que escondeu esta função quebrada.
        return json({ error: error?.message ?? 'erro', slots: [] });
    }
});

// Próxima ocorrência do dia da semana, em data LOCAL. `toISOString()` aqui
// pulava para o dia seguinte depois das 21h no Brasil (mesma armadilha de
// lib/dateUtils.ts).
function nextDateFor(dayIndex: number): string {
    const d = new Date();
    d.setDate(d.getDate() + ((dayIndex + 7 - d.getDay()) % 7 || 7));
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}
