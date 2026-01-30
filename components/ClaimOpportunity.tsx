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

            // B. Verificar Login
            const { data: authData, error: authError } = await supabase.auth.getUser();

            if (authError || !authData.user) {
                const returnUrl = window.location.href;
                window.location.href = `/login?redirectTo=${encodeURIComponent(returnUrl)}`;
                return;
            }

            const currentUser = authData.user;
            setUser(currentUser);

            // C. Buscar Nome do Professor
            try {
                const { data: profileData } = await supabase
                    .from('profiles')
                    .select('full_name')
                    .eq('id', currentUser.id)
                    .single();
                setProfName(profileData?.full_name || currentUser.email || 'Professor');
            } catch (err) { }

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

                    const status = oppData.status?.toLowerCase();
                    if (status === 'claimed' || status === 'filled') {
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
        setClaiming(true);

        try {
            // Check status again just in case
            if (opp.status?.toLowerCase() !== 'open') throw new Error("Vaga já preenchida.");

            // A.0. CONFLICT CHECK (Prevent Double Booking)
            const { data: conflicts } = await supabase
                .from('appointments')
                .select('id')
                .eq('professor_id', user.id)
                .eq('start_time', isoDate)
                .neq('status', 'cancelled')
                .limit(1);

            if (conflicts && conflicts.length > 0) {
                throw new Error("Você já possui um agendamento neste mesmo dia e horário!");
            }

            // A. Insert Appointment
            const { error: insertError } = await supabase
                .from('appointments')
                .insert({
                    start_time: isoDate,
                    type: 'experimental',
                    status: 'scheduled',
                    professor_id: user.id,
                    student_name: studentName,
                    student_phone: studentPhone
                });

            if (insertError) throw new Error("Erro ao criar agendamento no banco.");

            // B. Update Opportunity
            const { error: updateError } = await supabase
                .from('opportunities')
                .update({ status: 'claimed', professor_id: user.id })
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
