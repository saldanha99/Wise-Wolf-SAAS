
import React, { useState } from 'react';
import { Sparkles, X, Clock, User, Phone, Send, Zap, Calendar, Plus, Minus, Users, MessageCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

// =====================================================
// WEEKDAY CONFIG
// =====================================================
const WEEKDAYS = [
    { value: 'monday', label: 'Segunda-feira' },
    { value: 'tuesday', label: 'Terça-feira' },
    { value: 'wednesday', label: 'Quarta-feira' },
    { value: 'thursday', label: 'Quinta-feira' },
    { value: 'friday', label: 'Sexta-feira' },
    { value: 'saturday', label: 'Sábado' },
    { value: 'sunday', label: 'Domingo' },
];

interface PreferredSlot {
    weekday: string;
    time: string;
}

const SmartFinder: React.FC<{ user?: any }> = ({ user }) => {
    const [isOpen, setIsOpen] = useState(false);

    // Form State
    const [studentName, setStudentName] = useState('');
    const [studentPhone, setStudentPhone] = useState('');
    const [studentInterests, setStudentInterests] = useState('');

    // Date State (Initial: Today's date YYYY-MM-DD)
    const [targetDate, setTargetDate] = useState<string>(new Date().toISOString().split('T')[0]);
    const [targetTime, setTargetTime] = useState<string>('19:00');

    // Preferred Slots (weekly preferences)
    const [preferredSlots, setPreferredSlots] = useState<PreferredSlot[]>([]);

    // Modo de disparo: 'individual' manda DM só pros professores ativos; 'group'
    // posta no grupo de professores configurado em WhatsApp (Conexão).
    const [dispatchMode, setDispatchMode] = useState<'individual' | 'group'>('individual');

    const [loading, setLoading] = useState(false);

    // Preferred Slots helpers
    const addSlot = () => {
        if (preferredSlots.length >= 10) return;
        setPreferredSlots([...preferredSlots, { weekday: 'monday', time: '19:00' }]);
    };

    const removeSlot = (index: number) => {
        setPreferredSlots(preferredSlots.filter((_, i) => i !== index));
    };

    const updateSlot = (index: number, field: 'weekday' | 'time', value: string) => {
        const updated = [...preferredSlots];
        updated[index] = { ...updated[index], [field]: value };
        setPreferredSlots(updated);
    };

    const handleBroadcast = async () => {
        if (!studentName || !studentPhone || !targetTime || !targetDate) {
            alert("Por favor, preencha Nome, WhatsApp, Data e Horário.");
            return;
        }

        setLoading(true);
        try {
            // "Smart Connect" Integration:
            const { data: { session }, error: sessionError } = await supabase.auth.getSession();

            if (sessionError || !session) {
                console.error("Session Error:", sessionError);
                alert("Erro de Sessão: Você precisa estar logado.");
                setLoading(false);
                return;
            }

            console.log("Token:", session.access_token.substring(0, 10) + "...");

            const localInstance = localStorage.getItem('whatsapp_instance');
            const userInstance = user?.tenant?.whatsapp_instance;
            const instanceName = localInstance || userInstance || "wise wolf";

            // DIRECT FETCH to bypass potential supabase-js issues
            const PROJECT_REF = "dvalxbtngopxopzcbfdm"; // Taken from lib/supabase.ts
            const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/broadcast-opportunity`;

            // Hardcoded Anon Key (from lib/supabase.ts) to pass Gateway Check
            const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || supabase['supabaseKey'];

            const response = await fetch(FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ANON_KEY}`, // Pass Gateway as Anon
                    'x-user-token': session.access_token,  // Pass User for Logic
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    student_name: studentName,
                    student_phone: studentPhone,
                    date: targetDate,
                    time: targetTime,
                    interests: studentInterests,
                    preferred_slots: preferredSlots.length > 0 ? preferredSlots : undefined,
                    dispatch_mode: dispatchMode,
                })
            });

            if (!response.ok) {
                const text = await response.text();
                // ... rest of error handling ...
                console.error("Fetch Error:", response.status, text);
                if (response.status === 401) {
                    alert(`Erro 401 (Não Autorizado): O servidor rejeitou o token.\nDetalhes: ${text.substring(0, 100)}`);
                } else {
                    alert(`Erro ${response.status}: ${text.substring(0, 100)}`);
                }
                setLoading(false);
                return;
            }

            const data = await response.json();

            if (data && data.error) throw new Error(data.error);

            // Use the ACTUAL instance reported by the backend
            const realInstance = data.instance_used || "Instância Desconhecida";

            const isGroupMode = data.mode === 'group';

            if (data.warning) {
                const detail = isGroupMode
                    ? `Grupo: '${data.destination_group}'`
                    : `Professores notificados: ${data.recipients ?? 0}/${data.total_active_teachers ?? 0}`;
                alert(`⚠️ Vaga criada, mas FALHA no WhatsApp!\nInstância: '${realInstance}'\n${detail}\nErro: ${data.warning}`);
            } else {
                const detail = isGroupMode
                    ? `Grupo: '${data.destination_group}'`
                    : `Professores notificados: ${data.recipients ?? 0}/${data.total_active_teachers ?? 0}`;
                alert(`🚀 Oportunidade enviada via '${realInstance}'!\n${detail}.\nID: ${data.id}`);
            }

            // Clear fields (preserve date/time for convenience?)
            setStudentName('');
            setStudentPhone('');
            setStudentInterests('');
            setPreferredSlots([]);
            setIsOpen(false);

        } catch (err: any) {
            alert("Erro ao disparar: " + err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            {/* Floating Trigger Button */}
            <button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 right-6 z-50 bg-gradient-to-r from-orange-500 to-red-600 text-white p-3 rounded-full shadow-lg hover:scale-110 active:scale-95 transition-all flex items-center justify-center group"
                title="Lançar Vaga"
            >
                <Zap size={28} fill="currentColor" className="group-hover:animate-pulse" />
            </button>

            {/* Modal Drawer */}
            {isOpen && (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in">
                    <div className="w-full max-w-md bg-brand-surface h-full shadow-2xl p-6 overflow-y-auto animate-in slide-in-from-right duration-300 flex flex-col">

                        {/* Header */}
                        <div className="flex justify-between items-center mb-8">
                            <h2 className="text-2xl font-black text-brand-text flex items-center gap-2 uppercase tracking-tight">
                                <Zap className="text-orange-500" size={28} />
                                Lançador
                            </h2>
                            <button onClick={() => setIsOpen(false)} className="p-2 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 rounded-full transition-colors">
                                <X size={24} className="text-brand-muted" />
                            </button>
                        </div>

                        <div className="flex-1 space-y-8">

                            {/* Student Info */}
                            <div className="space-y-4">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2">
                                    <User size={14} /> Dados do Lead
                                </p>
                                <input
                                    value={studentName}
                                    onChange={(e) => setStudentName(e.target.value)}
                                    placeholder="Nome do Aluno (Ex: João)"
                                    className="w-full px-4 py-3 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                />
                                <div className="relative">
                                    <input
                                        value={studentPhone}
                                        onChange={(e) => setStudentPhone(e.target.value)}
                                        placeholder="WhatsApp (Ex: 5511999999999)"
                                        className="w-full pl-10 pr-4 py-3 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                    />
                                    <Phone className="absolute left-3 top-3.5 text-brand-muted" size={18} />
                                </div>
                                <textarea
                                    value={studentInterests}
                                    onChange={(e) => setStudentInterests(e.target.value)}
                                    placeholder="Interesse / Objetivo (Ex: Inglês para viagem, Reforço escolar...)"
                                    className="w-full px-4 py-3 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors resize-none h-24"
                                />
                            </div>

                            {/* Date & Time Slot */}
                            <div className="space-y-4">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2">
                                    <Clock size={14} /> Data e Horário da Experimental
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    {/* Date Picker */}
                                    <div className="relative">
                                        <input
                                            type="date"
                                            value={targetDate}
                                            onChange={(e) => setTargetDate(e.target.value)}
                                            className="w-full pl-10 pr-4 py-4 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-2xl font-bold text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                        />
                                        <Calendar className="absolute left-3 top-4.5 text-brand-muted" size={20} />
                                    </div>

                                    {/* Time Input */}
                                    <div className="relative">
                                        <input
                                            type="time"
                                            value={targetTime}
                                            onChange={(e) => setTargetTime(e.target.value)}
                                            className="w-full pl-10 pr-4 py-4 bg-orange-50 dark:bg-orange-900/10 border-2 border-orange-100 dark:border-orange-800/30 rounded-2xl font-black text-xl text-orange-600 dark:text-orange-400 focus:outline-none focus:border-orange-500 text-center shadow-inner"
                                        />
                                        <Clock className="absolute left-3 top-5 text-orange-300" size={20} />
                                    </div>
                                </div>
                            </div>

                            {/* ============================================= */}
                            {/* PREFERRED WEEKLY SLOTS (NEW) */}
                            {/* ============================================= */}
                            <div className="space-y-3">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2">
                                    <Calendar size={14} /> Preferência de horários na semana
                                    <span className="text-[10px] font-normal text-slate-300 ml-1">(opcional)</span>
                                </p>

                                {preferredSlots.map((slot, idx) => (
                                    <div key={idx} className="flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
                                        {/* Weekday */}
                                        <select
                                            value={slot.weekday}
                                            onChange={(e) => updateSlot(idx, 'weekday', e.target.value)}
                                            className="flex-1 px-3 py-2.5 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-xl text-sm font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                        >
                                            {WEEKDAYS.map(day => (
                                                <option key={day.value} value={day.value}>{day.label}</option>
                                            ))}
                                        </select>

                                        {/* Time */}
                                        <input
                                            type="time"
                                            value={slot.time}
                                            onChange={(e) => updateSlot(idx, 'time', e.target.value)}
                                            className="w-28 px-3 py-2.5 bg-orange-50 dark:bg-orange-900/10 border-2 border-orange-100 dark:border-orange-800/30 rounded-xl font-bold text-sm text-orange-600 dark:text-orange-400 text-center focus:border-orange-500 focus:ring-0 transition-colors"
                                        />

                                        {/* Remove */}
                                        <button
                                            onClick={() => removeSlot(idx)}
                                            className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                        >
                                            <Minus size={16} />
                                        </button>
                                    </div>
                                ))}

                                {preferredSlots.length < 10 && (
                                    <button
                                        onClick={addSlot}
                                        className="flex items-center gap-2 text-xs font-bold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-3 py-2 rounded-lg transition-colors w-full justify-center border-2 border-dashed border-indigo-200 hover:border-indigo-300"
                                    >
                                        <Plus size={14} />
                                        Adicionar horário
                                    </button>
                                )}
                            </div>

                            {/* Dispatch Mode Toggle */}
                            <div className="space-y-3">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2">
                                    <Send size={14} /> Como disparar
                                </p>
                                <div className="grid grid-cols-2 gap-2 p-1 bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border rounded-xl">
                                    <button
                                        type="button"
                                        onClick={() => setDispatchMode('individual')}
                                        className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-colors ${dispatchMode === 'individual'
                                            ? 'bg-orange-500 text-white shadow'
                                            : 'text-brand-muted hover:bg-brand-surface'
                                            }`}
                                    >
                                        <Users size={14} /> Todos os Professores
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setDispatchMode('group')}
                                        className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-colors ${dispatchMode === 'group'
                                            ? 'bg-orange-500 text-white shadow'
                                            : 'text-brand-muted hover:bg-brand-surface'
                                            }`}
                                    >
                                        <MessageCircle size={14} /> Só no Grupo
                                    </button>
                                </div>
                                <p className="text-[10px] text-brand-muted font-medium px-1">
                                    {dispatchMode === 'individual'
                                        ? 'Manda DM individual só pros professores ativos (desligados/suspensos não recebem).'
                                        : "Posta no grupo de professores configurado em WhatsApp (Conexão) — todo mundo no grupo vê, incluindo quem não estiver mais ativo."}
                                </p>
                            </div>

                        </div>

                        {/* Action Button */}
                        <div className="mt-8 pt-6 border-t border-brand-border">
                            <button
                                onClick={handleBroadcast}
                                disabled={loading}
                                className="w-full bg-gradient-to-r from-orange-500 to-red-600 text-white py-5 rounded-2xl font-black text-lg shadow-xl shadow-orange-200 dark:shadow-none hover:shadow-2xl hover:scale-[1.02] active:scale-95 transition-all flex justify-center items-center gap-3 disabled:opacity-70 disabled:grayscale"
                            >
                                {loading ? (
                                    <div className="animate-spin rounded-full h-6 w-6 border-4 border-white border-t-transparent" />
                                ) : (
                                    <>
                                        <Send size={24} fill="white" />
                                        DISPARAR AGORA
                                    </>
                                )}
                            </button>
                            <p className="text-center text-[10px] text-brand-muted mt-3 font-medium">
                                {dispatchMode === 'individual'
                                    ? `Envia individualmente a cada professor ativo de '${localStorage.getItem('whatsapp_instance') || "wise wolf"}'.`
                                    : `Envia pro grupo de professores de '${localStorage.getItem('whatsapp_instance') || "wise wolf"}'.`}
                            </p>
                        </div>

                    </div>
                </div>
            )}
        </>
    );
};

export default SmartFinder;
