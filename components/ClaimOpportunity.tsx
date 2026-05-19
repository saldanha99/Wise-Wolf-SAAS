import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Smartphone, Check, Calendar, Clock, ArrowRight, MessageCircle, Lock, AlertCircle, TrendingUp } from 'lucide-react';
import { User as AuthUser } from '@supabase/supabase-js';

// CONSTANTES
const DIRECTOR_GROUP_ID = "120363422315263337@g.us";

interface ClaimProps {
    opportunityId: string | null;
}

const ClaimOpportunity: React.FC<ClaimProps> = ({ opportunityId }) => {
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
            // A. Parse URL Params
            const params = new URLSearchParams(window.location.search);
            const dateParam = params.get('date'); // YYYY-MM-DD
            const timeParam = params.get('time'); // HH:mm
            const sName = params.get('studentName');
            const sPhone = params.get('studentPhone');

            if (sName) setStudentName(sName);
            if (sPhone) setStudentPhone(sPhone);
            if (timeParam) setTimeStr(timeParam);

            if (dateParam && timeParam) {
                // 1. Lógica solicitada: dateFormatted Manual
                // "2026-01-27" -> ["2026", "01", "27"] -> ["27", "01", "2026"] -> "27/01/2026"
                const dateParts = dateParam.split('-');
                if (dateParts.length === 3) {
                    const formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
                    const friendlyDate = `${formattedDate} às ${timeParam}`;
                    setFormattedDateStr(friendlyDate);
                }

                // 2. Lógica solicitada: ISO Date para banco
                // new Date("2026-01-27T19:00:00").toISOString()
                try {
                    const dt = new Date(`${dateParam}T${timeParam}:00`);
                    setUrlDate(dt);
                    setIsoDate(dt.toISOString());
                } catch (e) {
                    console.error("Erro data ISO", e);
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
            if (opportunityId) {
                const { data: oppData, error: oppError } = await supabase
                    .from('opportunities')
                    .select('*')
                    .eq('id', opportunityId)
                    .single();

                if (!oppError && oppData) {
                    setOpp(oppData);
                    if (!sName) setStudentName(oppData.student_name);
                    if (!sPhone) setStudentPhone(oppData.student_phone);

                    const status = oppData.status?.toUpperCase();
                    if (status === 'CLAIMED' || status === 'FILLED') {
                        setError("Esta oportunidade já foi preenchida.");
                        setIsClaimed(true);
                    }
                } else {
                    setError("Esta oportunidade não foi encontrada.");
                }
            }
            setIsLoading(false);
        };
        init();
    }, [opportunityId]);

    // 3. HANDLE CLAIM
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
            // Check status again just in case
            if (opp.status?.toLowerCase() !== 'open') throw new Error("Vaga já preenchida.");

            // A.0. CONFLICT CHECK — 30-Minute Gap Rule (start-to-start)
            const BUFFER_MINUTES = 30;
            const trialStart = new Date(isoDate);

            console.log('[ClaimOpp] Buffer check — trialStart:', trialStart.toISOString());

            // A.0.a Check one-time appointments (same day range)
            const dayStart = new Date(trialStart);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(trialStart);
            dayEnd.setHours(23, 59, 59, 999);

            // CLEANUP: Cancel orphaned experimental trial bookings before conflict check
            const { data: expAppts } = await supabase
                .from('trial_bookings')
                .select('id')
                .eq('teacher_id', user.id)
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
                            .from('trial_bookings')
                            .update({ status: 'cancelled' })
                            .eq('id', ea.id);
                        console.log('[ClaimOpp] ♻️ Cancelled orphaned trial booking:', ea.id);
                    }
                }
            }

            const { data: dayAppointments } = await supabase
                .from('trial_bookings')
                .select('id, start_time, status')
                .eq('teacher_id', user.id)
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

            console.log('[ClaimOpp] ✅ No conflicts found, proceeding with claim');

            // A. Insert Trial Booking & capture its ID
            const { data: appointmentData, error: insertError } = await supabase
                .from('trial_bookings')
                .insert({
                    start_time: isoDate,
                    status: 'scheduled',
                    teacher_id: user.id,
                    lead_name: studentName,
                    lead_phone: studentPhone
                })
                .select('id')
                .single();

            if (insertError || !appointmentData) throw new Error("Erro ao criar agendamento no banco.");

            // B. Update Opportunity with trial data
            const { error: updateError } = await supabase
                .from('opportunities')
                .update({
                    status: 'CLAIMED',
                    winner_teacher_id: user.id,
                    trial_appointment_id: appointmentData.id,
                    trial_status: 'SCHEDULED',
                    conversion_status: 'OPEN'
                })
                .eq('id', opp.id);

            if (updateError) throw updateError;

            // C. Notify Logic (Payload exato pedido + 401 BYPASS STRATEGY)
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
                        studentName: studentName || opp.student_name,
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
            <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface text-white">
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
            <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface text-white">
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
            <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface-2 p-6 text-center">
                <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-6">
                    <AlertCircle size={40} className="text-red-500" />
                </div>
                <h1 className="text-2xl font-bold text-brand-text mb-2">{error}</h1>
                <button
                    onClick={() => window.location.href = '/'}
                    className="mt-6 px-8 py-3 bg-slate-200 text-brand-text rounded-lg font-bold hover:bg-slate-300 transition-colors"
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
                <h1 className="text-3xl font-black text-brand-text mb-2">🎉 Aula Confirmada!</h1>
                <p className="text-brand-muted mb-8 max-w-md mx-auto leading-relaxed">
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
                        className="w-full py-4 bg-slate-200 text-brand-text rounded-xl font-bold hover:bg-slate-300 transition-colors"
                    >
                        Voltar ao Dashboard
                    </button>
                </div>
            </div>
        );
    }

    // RENDER: CLAIM VIEW (Confirm Page)
    return (
        <div className="min-h-screen bg-brand-surface-2 flex flex-col font-sans">
            <div className="bg-brand-surface text-white pt-12 pb-24 px-6 rounded-b-[3rem] shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-400 via-slate-900 to-slate-900"></div>
                <div className="relative z-10 text-center">
                    <span className="inline-block py-1 px-3 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[10px] font-black tracking-widest uppercase mb-4 backdrop-blur-md">
                        AULA EXPERIMENTAL
                    </span>
                    <h1 className="text-4xl font-black mb-2 tracking-tight">{studentName || 'Novo Aluno'}</h1>
                </div>
            </div>

            <div className="flex-1 px-6 -mt-16 pb-8 max-w-lg mx-auto w-full relative z-20">
                <div className="bg-brand-surface rounded-3xl shadow-xl p-1 border-4 border-white/50 backdrop-blur-sm">
                    <div className="bg-brand-surface rounded-[1.3rem] p-6 border border-brand-border">
                        <div className="grid gap-4 mb-8">
                            {/* DATA CARD */}
                            <div className="flex items-center gap-4 p-4 bg-brand-surface-2 rounded-2xl border border-brand-border">
                                <div className="w-12 h-12 rounded-xl bg-brand-surface shadow-sm flex items-center justify-center text-indigo-600 border border-indigo-50">
                                    <Calendar size={24} />
                                </div>
                                <div>
                                    <p className="text-[10px] text-brand-muted font-black uppercase tracking-wider">DATA CONFIRMADA</p>
                                    <p className="text-lg font-bold text-brand-text leading-tight">
                                        {formattedDateStr || 'Data não especificada'}
                                    </p>
                                </div>
                            </div>

                            {/* HORARIO CARD */}
                            <div className="flex items-center gap-4 p-4 bg-brand-surface-2 rounded-2xl border border-brand-border">
                                <div className="w-12 h-12 rounded-xl bg-brand-surface shadow-sm flex items-center justify-center text-orange-600 border border-orange-50">
                                    <Clock size={24} />
                                </div>
                                <div>
                                    <p className="text-[10px] text-brand-muted font-black uppercase tracking-wider">HORÁRIO</p>
                                    <p className="text-xl font-bold text-brand-text">
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
