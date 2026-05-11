import React, { useState, useEffect } from 'react';
import { supabase, supabaseUrl, supabaseAnonKey } from '../lib/supabase';
import { Smartphone, Check, Calendar, Clock, ArrowRight, MessageCircle, Lock, AlertCircle, TrendingUp, ShieldAlert } from 'lucide-react';
import { User as AuthUser } from '@supabase/supabase-js';

// CONSTANTES
const DIRECTOR_GROUP_ID = "120363422315263337@g.us";
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || supabaseAnonKey;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || supabaseUrl || '';

interface ClaimProps {
    opportunityId: string | null;
    claimToken?: string | null;  // JWT signed claim token (new flow)
}

const ClaimOpportunity: React.FC<ClaimProps> = ({ opportunityId, claimToken }) => {
    // 1. ESTADOS
    const [isLoading, setIsLoading] = useState(true);
    const [user, setUser] = useState<AuthUser | null>(null);
    const [profName, setProfName] = useState('');

    // Data State
    const [opp, setOpp] = useState<any | null>(null);
    const [claiming, setClaiming] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');
    const [isClaimed, setIsClaimed] = useState(false);
    const [resolvedOppId, setResolvedOppId] = useState<string | null>(opportunityId);
    const [isLegacyLink, setIsLegacyLink] = useState(false);
    const [tokenExpired, setTokenExpired] = useState(false);

    // URL Params State
    const [urlDate, setUrlDate] = useState<Date | null>(null);
    const [formattedDateStr, setFormattedDateStr] = useState('');
    const [isoDate, setIsoDate] = useState('');
    const [studentName, setStudentName] = useState('');
    const [studentPhone, setStudentPhone] = useState('');
    const [timeStr, setTimeStr] = useState('');

    // Auth / Role State
    const [userRole, setUserRole] = useState<string>('');
    const [accessDenied, setAccessDenied] = useState(false);
    const [redirecting, setRedirecting] = useState(false);

    // 2. AUTH & PROFILE GUARD + URL PARAMS
    useEffect(() => {
        const init = async () => {
            // ── A. RESOLVE JWT TOKEN OR LEGACY PARAMS ──────────────────
            const params = new URLSearchParams(window.location.search);

            if (claimToken) {
                // NEW FLOW: Resolve JWT via Edge Function
                try {
                    console.log('[ClaimOpp] Resolving JWT claim token...');
                    const res = await fetch(`${SUPABASE_URL}/functions/v1/resolve-offer`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${ANON_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ token: claimToken, type: 'claim' })
                    });

                    if (!res.ok) {
                        const errBody = await res.json().catch(() => ({}));
                        if (res.status === 401 || errBody?.error?.includes('expired')) {
                            setTokenExpired(true);
                            setError('Este link expirou. Solicite um novo link ao coordenador.');
                            setIsLoading(false);
                            return;
                        }
                        throw new Error(errBody?.error || `HTTP ${res.status}`);
                    }

                    const resolved = await res.json();
                    console.log('[ClaimOpp] JWT resolved:', resolved);

                    // JWT payload contains: opp_id, date, time, studentName, studentPhone
                    setResolvedOppId(resolved.opp_id || resolved.opportunity_id);
                    if (resolved.student_name) setStudentName(resolved.student_name);
                    if (resolved.student_phone) setStudentPhone(resolved.student_phone);
                    if (resolved.date) {
                        const dateParam = resolved.date;
                        const timeParam = resolved.time || '';
                        if (timeParam) setTimeStr(timeParam);
                        const dateParts = dateParam.split('-');
                        if (dateParts.length === 3) {
                            const formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
                            setFormattedDateStr(`${formattedDate} às ${timeParam}`);
                        }
                        try {
                            const dt = new Date(`${dateParam}T${timeParam}:00`);
                            setUrlDate(dt);
                            setIsoDate(dt.toISOString());
                        } catch (e) {
                            console.error('Erro data ISO', e);
                        }
                    }
                } catch (jwtErr: any) {
                    console.error('[ClaimOpp] JWT resolution failed:', jwtErr);
                    setError('Link inválido ou expirado. Solicite um novo link.');
                    setIsLoading(false);
                    return;
                }
            } else {
                // LEGACY FLOW: Read from URL params (retro-compat 30d)
                setIsLegacyLink(true);
                console.warn('[ClaimOpp] ⚠️ Using legacy link (no JWT token)');

                const dateParam = params.get('date');
                const timeParam = params.get('time');
                const sName = params.get('studentName');
                const sPhone = params.get('studentPhone');

                if (sName) setStudentName(sName);
                if (sPhone) setStudentPhone(sPhone);
                if (timeParam) setTimeStr(timeParam);
                setResolvedOppId(opportunityId);

                if (dateParam && timeParam) {
                    const dateParts = dateParam.split('-');
                    if (dateParts.length === 3) {
                        const formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
                        setFormattedDateStr(`${formattedDate} às ${timeParam}`);
                    }
                    try {
                        const dt = new Date(`${dateParam}T${timeParam}:00`);
                        setUrlDate(dt);
                        setIsoDate(dt.toISOString());
                    } catch (e) {
                        console.error('Erro data ISO', e);
                    }
                }
            }

            // B. Verificar Login — GUARD COMPLETO
            // Tudo dentro de try-catch: qualquer falha = redirecionar para login
            let currentUser: any = null;
            try {
                // 1. Check local session (rápido)
                const { data: sessionData } = await supabase.auth.getSession();
                console.log('[ClaimOpp] getSession result:', !!sessionData?.session);

                if (!sessionData?.session) {
                    console.log('[ClaimOpp] Sem sessão local → redirect login');
                    setRedirecting(true);
                    window.location.replace(`/login?redirectTo=${encodeURIComponent(window.location.href)}`);
                    return;
                }

                // 2. Validar token no servidor
                const { data: authData, error: authError } = await supabase.auth.getUser();
                console.log('[ClaimOpp] getUser result:', !!authData?.user, 'error:', authError?.message);

                if (authError || !authData?.user) {
                    console.log('[ClaimOpp] Token inválido → redirect login');
                    setRedirecting(true);
                    window.location.replace(`/login?redirectTo=${encodeURIComponent(window.location.href)}`);
                    return;
                }

                currentUser = authData.user;
            } catch (authException) {
                // Qualquer exceção na verificação de auth = sem login
                console.error('[ClaimOpp] Auth exception → redirect login:', authException);
                setRedirecting(true);
                window.location.replace(`/login?redirectTo=${encodeURIComponent(window.location.href)}`);
                return;
            }

            // Se chegou aqui, currentUser é válido e autenticado
            setUser(currentUser);

            // C. Buscar Perfil + Validar Role (só executa se autenticado)
            try {
                const { data: profileData } = await supabase
                    .from('profiles')
                    .select('full_name, role')
                    .eq('id', currentUser.id)
                    .single();

                console.log('[ClaimOpp] Profile role:', profileData?.role);

                setProfName(profileData?.full_name || currentUser.email || 'Professor');
                const role = profileData?.role || '';
                setUserRole(role);

                // SECURITY: Only TEACHER role can claim opportunities
                if (role !== 'TEACHER') {
                    setAccessDenied(true);
                    setError('Apenas perfis de professor podem aceitar vagas experimentais.');
                    setIsLoading(false);
                    return;
                }
            } catch (err) {
                console.error('[ClaimOpp] Profile fetch error:', err);
                setError('Erro ao carregar perfil. Tente novamente.');
                setIsLoading(false);
                return;
            }

            // D. Dados da Vaga
            const finalOppId = claimToken ? resolvedOppId : opportunityId;
            if (finalOppId) {
                const { data: oppData, error: oppError } = await supabase
                    .from('opportunities')
                    .select('*')
                    .eq('id', finalOppId)
                    .single();

                if (!oppError && oppData) {
                    setOpp(oppData);
                    if (!studentName) setStudentName(oppData.student_name);
                    if (!studentPhone) setStudentPhone(oppData.student_phone);

                    const status = oppData.status?.toUpperCase();
                    if (status === 'CLAIMED' || status === 'FILLED') {
                        setError('Esta oportunidade já foi preenchida.');
                        setIsClaimed(true);
                    }
                } else {
                    setError('Esta oportunidade não foi encontrada.');
                }
            } else if (!claimToken) {
                setError('Link incompleto — ID da oportunidade ausente.');
            }

            // E. Log legacy link usage for migration tracking
            if (isLegacyLink && finalOppId) {
                supabase.rpc('log_security_event', {
                    p_event_type: 'LEGACY_LINK_USED',
                    p_entity_type: 'opportunity',
                    p_entity_id: finalOppId,
                    p_metadata: { source: 'claim-opportunity', url: window.location.href }
                }).then(() => {}).catch(() => {}); // Fire-and-forget
            }

            setIsLoading(false);
        };
        init();
    }, [opportunityId, claimToken, resolvedOppId]);

    // 3. HANDLE CLAIM — Uses atomic RPC (no race condition)
    const handleClaim = async () => {
        if (!opp || !user || !isoDate) {
            if (!isoDate) setError("Dados de agendamento incompletos (Data/Hora).");
            return;
        }

        // SECURITY: Double-check role before proceeding
        if (accessDenied || userRole !== 'TEACHER') {
            setError('Apenas perfis de professor podem aceitar vagas experimentais.');
            return;
        }
        setClaiming(true);

        try {
            // A.0. CONFLICT CHECK — 30-Minute Gap Rule (start-to-start)
            // This remains client-side as it checks the TEACHER's own schedule
            const BUFFER_MINUTES = 30;
            const trialStart = new Date(isoDate);

            console.log('[ClaimOpp] Buffer check — trialStart:', trialStart.toISOString());

            // A.0.a Check one-time appointments (same day range)
            const dayStart = new Date(trialStart);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(trialStart);
            dayEnd.setHours(23, 59, 59, 999);

            // CLEANUP: Cancel orphaned experimental appointments before conflict check
            const { data: expAppts } = await supabase
                .from('appointments')
                .select('id')
                .eq('professor_id', user.id)
                .eq('type', 'experimental')
                .eq('status', 'scheduled')
                .gte('start_time', dayStart.toISOString())
                .lte('start_time', dayEnd.toISOString());

            if (expAppts && expAppts.length > 0) {
                for (const ea of expAppts) {
                    const { data: linkedOpp } = await supabase
                        .from('opportunities')
                        .select('id, status')
                        .eq('trial_appointment_id', ea.id)
                        .in('status', ['CLAIMED', 'FILLED'])
                        .maybeSingle();

                    if (!linkedOpp) {
                        await supabase
                            .from('appointments')
                            .update({ status: 'cancelled' })
                            .eq('id', ea.id);
                        console.log('[ClaimOpp] ♻️ Cancelled orphaned appointment:', ea.id);
                    }
                }
            }

            const { data: dayAppointments } = await supabase
                .from('appointments')
                .select('id, start_time, status')
                .eq('professor_id', user.id)
                .neq('status', 'cancelled')
                .gte('start_time', dayStart.toISOString())
                .lte('start_time', dayEnd.toISOString());

            console.log('[ClaimOpp] Day appointments found:', dayAppointments?.length);

            if (dayAppointments && dayAppointments.length > 0) {
                const existingTrialApptId = opp.trial_appointment_id;
                const filteredAppointments = dayAppointments.filter(a => a.id !== existingTrialApptId);

                for (const appt of filteredAppointments) {
                    const existStart = new Date(appt.start_time);
                    const diffMinutes = Math.abs(trialStart.getTime() - existStart.getTime()) / 60000;

                    console.log('[ClaimOpp] Appt:', appt.id, 'at', existStart.toLocaleTimeString('pt-BR'), '| diff:', diffMinutes, 'min | conflict:', diffMinutes < BUFFER_MINUTES);

                    if (diffMinutes < BUFFER_MINUTES) {
                        throw new Error(
                            `Você não pode aceitar esta aula. É necessário um intervalo de ${BUFFER_MINUTES} minutos entre alunos na sua agenda. Conflito com compromisso às ${existStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`
                        );
                    }
                }
            }

            // A.0.b Check recurring bookings (weekly classes for same day-of-week)
            const DAYS_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
            const trialDayName = DAYS_PT[trialStart.getDay()];

            const { data: dayBookings } = await supabase
                .from('bookings')
                .select('id, time_slot')
                .eq('teacher_id', user.id)
                .eq('day_of_week', trialDayName);

            console.log('[ClaimOpp] Recurring bookings for', trialDayName, ':', dayBookings?.length);

            if (dayBookings && dayBookings.length > 0) {
                for (const bk of dayBookings) {
                    if (!bk.time_slot) continue;
                    const [bkH, bkM] = bk.time_slot.substring(0, 5).split(':').map(Number);
                    const bkStart = new Date(trialStart);
                    bkStart.setHours(bkH, bkM, 0, 0);

                    const diffMinutes = Math.abs(trialStart.getTime() - bkStart.getTime()) / 60000;

                    console.log('[ClaimOpp] Booking:', bk.id, 'at', bk.time_slot, '| diff:', diffMinutes, 'min | conflict:', diffMinutes < BUFFER_MINUTES);

                    if (diffMinutes < BUFFER_MINUTES) {
                        throw new Error(
                            `Você não pode aceitar esta aula. É necessário um intervalo de ${BUFFER_MINUTES} minutos entre alunos na sua agenda. Conflito com aula regular às ${bk.time_slot.substring(0, 5)}.`
                        );
                    }
                }
            }

            console.log('[ClaimOpp] ✅ No conflicts found, proceeding with atomic claim');

            // ── ATOMIC CLAIM via RPC ──────────────────────────────────
            // Uses claim_with_token (JWT path) or claim_opportunity (legacy path)
            let claimResult: any;
            let claimRpcError: any;

            if (claimToken) {
                // Hash the token client-side for consumed_tokens check
                const encoder = new TextEncoder();
                const data = encoder.encode(claimToken);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

                const rpcResult = await supabase
                    .rpc('claim_with_token', {
                        p_opp_id: opp.id,
                        p_teacher_id: user.id,
                        p_token_hash: tokenHash
                    });
                claimResult = rpcResult.data;
                claimRpcError = rpcResult.error;
            } else {
                // Legacy path (retro-compat)
                const rpcResult = await supabase
                    .rpc('claim_opportunity', {
                        p_opp_id: opp.id,
                        p_teacher_id: user.id
                    });
                claimResult = rpcResult.data;
                claimRpcError = rpcResult.error;
            }

            if (claimRpcError) {
                console.error('[ClaimOpp] RPC error:', claimRpcError);
                throw new Error('Erro interno ao processar reivindicação.');
            }

            if (!claimResult?.success) {
                // 409 — Already claimed by another teacher
                if (claimResult?.error === 'ALREADY_CLAIMED') {
                    setIsClaimed(true);
                }
                throw new Error(claimResult?.message || 'Esta vaga já foi preenchida.');
            }

            // ── POST-CLAIM: Insert appointment (after atomic claim succeeds) ──
            const { data: appointmentData, error: insertError } = await supabase
                .from('appointments')
                .insert({
                    start_time: isoDate,
                    type: 'experimental',
                    status: 'scheduled',
                    professor_id: user.id,
                    student_name: claimResult.student_name || studentName,
                    student_phone: claimResult.student_phone || studentPhone
                })
                .select('id')
                .single();

            if (insertError || !appointmentData) {
                console.error('[ClaimOpp] Appointment insert failed:', insertError);
                // Claim succeeded but appointment failed — update opp with trial info anyway
            }

            // Update opportunity with trial appointment link
            if (appointmentData) {
                await supabase
                    .from('opportunities')
                    .update({
                        trial_appointment_id: appointmentData.id,
                        trial_status: 'SCHEDULED',
                        conversion_status: 'OPEN'
                    })
                    .eq('id', opp.id);
            }

            // ── NOTIFY DIRECTORS ──────────────────────────────────────
            try {
                const { data: sessionData } = await supabase.auth.getSession();
                const accessToken = sessionData.session?.access_token;

                if (!accessToken) throw new Error("No Access Token available for Notification");

                const PROJECT_REF = "dvalxbtngopxopzcbfdm";
                const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/notify-claim`;
                // @ts-ignore
                const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || supabase['supabaseKey'];

                const notifyResponse = await fetch(FUNCTION_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${ANON_KEY}`,
                        'x-user-token': accessToken,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        professorName: profName,
                        studentName: claimResult.student_name || studentName || opp.student_name,
                        dateFormatted: formattedDateStr,
                        directorGroupId: DIRECTOR_GROUP_ID,
                        opportunityId: opp.id
                    })
                });

                if (!notifyResponse.ok) {
                    const text = await notifyResponse.text();
                    console.error("Notify Error:", notifyResponse.status, text);
                }

            } catch (notifyErr) {
                console.error("Falha ao notificar diretoria:", notifyErr);
            }

            setSuccess(true);
            setIsClaimed(true);

        } catch (err: any) {
            console.error("Claim Error:", err);
            setError(err.message || "Erro ao processar.");
        } finally {
            setClaiming(false);
        }
    };


    // RENDER: REDIRECTING TO LOGIN
    if (redirecting) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
                <div className="animate-spin mb-4">
                    <Lock size={48} className="text-indigo-500" />
                </div>
                <p className="text-sm font-medium tracking-wider animate-pulse">REDIRECIONANDO PARA LOGIN...</p>
            </div>
        );
    }

    // RENDER: LOADING
    if (isLoading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
                <div className="animate-spin mb-4">
                    <Lock size={48} className="text-indigo-500" />
                </div>
                <p className="text-sm font-medium tracking-wider animate-pulse">VERIFICANDO DISPONIBILIDADE...</p>
            </div>
        );
    }

    // RENDER: ERROR
    if (error) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
                <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-6">
                    <AlertCircle size={40} className="text-red-500" />
                </div>
                <h1 className="text-2xl font-bold text-slate-800 mb-2">{error}</h1>
                <button
                    onClick={() => window.location.href = '/'}
                    className="mt-6 px-8 py-3 bg-slate-200 text-slate-700 rounded-lg font-bold hover:bg-slate-300 transition-colors"
                >
                    Voltar
                </button>
            </div>
        );
    }

    // RENDER: SUCCESS
    if (success || (isClaimed && !error)) {
        // Mensagem WhatsApp Final
        // "Olá ${studentName}, sou o professor ${profName}... aula confirmada para dia ${formattedDateStr} às ${timeStr}..."
        const fName = studentName.split(' ')[0];
        const msg = `Olá ${fName}, sou o professor ${profName}! Sua aula experimental foi confirmada para ${formattedDateStr} às ${timeStr}. Tudo certo para nosso encontro?`;

        const cleanPhone = studentPhone ? studentPhone.replace(/\D/g, '') : '';
        const waLink = cleanPhone
            ? `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(msg)}`
            : '#';

        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-emerald-50 p-6 text-center animate-in zoom-in-95 duration-500">
                <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mb-6 shadow-lg shadow-emerald-200">
                    <Check size={48} className="text-emerald-600" />
                </div>
                <h1 className="text-3xl font-black text-slate-900 mb-2">🎉 Aula Confirmada!</h1>
                <p className="text-slate-600 mb-8 max-w-md mx-auto leading-relaxed">
                    O agendamento foi realizado para <strong>{formattedDateStr} às {timeStr}</strong>.
                </p>

                <div className="flex flex-col gap-3 w-full max-w-xs">
                    {cleanPhone && (
                        <a
                            href={waLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full py-4 bg-emerald-500 text-white rounded-xl font-bold shadow-lg shadow-emerald-200 flex items-center justify-center gap-2 hover:translate-y-[-2px] transition-all"
                        >
                            <MessageCircle size={24} />
                            CHAMAR ALUNO AGORA
                        </a>
                    )}
                    <button
                        onClick={() => window.location.href = '/'}
                        className="w-full py-4 bg-slate-200 text-slate-700 rounded-xl font-bold hover:bg-slate-300 transition-colors"
                    >
                        Voltar ao Dashboard
                    </button>
                </div>
            </div>
        );
    }

    // RENDER: CLAIM VIEW (Confirm Page)
    return (
        <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
            <div className="bg-slate-900 text-white pt-12 pb-24 px-6 rounded-b-[3rem] shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-400 via-slate-900 to-slate-900"></div>
                <div className="relative z-10 text-center">
                    <span className="inline-block py-1 px-3 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[10px] font-black tracking-widest uppercase mb-4 backdrop-blur-md">
                        AULA EXPERIMENTAL
                    </span>
                    <h1 className="text-4xl font-black mb-2 tracking-tight">{studentName || 'Novo Aluno'}</h1>
                </div>
            </div>

            <div className="flex-1 px-6 -mt-16 pb-8 max-w-lg mx-auto w-full relative z-20">
                <div className="bg-white rounded-3xl shadow-xl p-1 border-4 border-white/50 backdrop-blur-sm">
                    <div className="bg-white rounded-[1.3rem] p-6 border border-slate-100">
                        <div className="grid gap-4 mb-8">
                            {/* DATA CARD */}
                            <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                                <div className="w-12 h-12 rounded-xl bg-white shadow-sm flex items-center justify-center text-indigo-600 border border-indigo-50">
                                    <Calendar size={24} />
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">DATA CONFIRMADA</p>
                                    <p className="text-lg font-bold text-slate-800 leading-tight">
                                        {formattedDateStr || 'Data não especificada'}
                                    </p>
                                </div>
                            </div>

                            {/* HORARIO CARD */}
                            <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                                <div className="w-12 h-12 rounded-xl bg-white shadow-sm flex items-center justify-center text-orange-600 border border-orange-50">
                                    <Clock size={24} />
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">HORÁRIO</p>
                                    <p className="text-xl font-bold text-slate-800">
                                        {timeStr || '--:--'}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* STUDENT INTEREST SECTION (from Opp) */}
                        {opp && opp.interests && (
                            <div className="mb-6 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                                <p className="text-[10px] text-indigo-400 font-black uppercase tracking-wider mb-2 flex items-center gap-2">
                                    <TrendingUp size={14} /> INTERESSE DO ALUNO
                                </p>
                                <p className="text-sm font-medium text-indigo-900 leading-relaxed">
                                    {opp.interests}
                                </p>
                            </div>
                        )}

                        <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-4 rounded-xl border border-amber-100/50 mb-6">
                            <p className="text-amber-800 text-xs font-semibold leading-relaxed text-center flex items-start justify-center gap-2">
                                <Clock size={14} className="mt-0.5 shrink-0" />
                                <span>Ao aceitar, este horário será <strong>bloqueado na agenda</strong> automaticamente.</span>
                            </p>
                        </div>

                        <button
                            onClick={handleClaim}
                            disabled={claiming || !formattedDateStr}
                            className="group w-full py-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-lg shadow-xl shadow-indigo-200 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-70 disabled:grayscale"
                        >
                            {claiming ? (
                                <>
                                    <div className="w-6 h-6 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                                    <span>AGENDANDO...</span>
                                </>
                            ) : (
                                <>
                                    <span>ACEITAR AULA</span>
                                    <ArrowRight className="group-hover:translate-x-1 transition-transform" strokeWidth={3} size={20} />
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ClaimOpportunity;
