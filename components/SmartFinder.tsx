
import React, { useState } from 'react';
import { Sparkles, X, Clock, User, Phone, Send, Zap, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';

const SmartFinder: React.FC<{ user?: any }> = ({ user }) => {
    const [isOpen, setIsOpen] = useState(false);

    // Form State
    const [studentName, setStudentName] = useState('');
    const [studentPhone, setStudentPhone] = useState('');
    const [studentInterests, setStudentInterests] = useState('');

    // Date State (Initial: Today's date YYYY-MM-DD)
    const [targetDate, setTargetDate] = useState<string>(new Date().toISOString().split('T')[0]);
    const [targetTime, setTargetTime] = useState<string>('19:00');

    const [loading, setLoading] = useState(false);

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
                    interests: studentInterests
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

            if (data.warning) {
                alert(`⚠️ Vaga criada, mas FALHA no WhatsApp!\nInstância: '${realInstance}'\nGrupo: '${data.destination_group}'\nErro: ${data.warning}`);
            } else {
                alert(`🚀 Oportunidade enviada via '${realInstance}'!\nGrupo: '${data.destination_group || "Padrão"}'\nID: ${data.id}`);
            }

            // Clear fields (preserve date/time for convenience?)
            setStudentName('');
            setStudentPhone('');
            setStudentInterests('');
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
                className="fixed bottom-6 right-6 z-50 bg-gradient-to-r from-orange-500 to-red-600 text-white p-4 rounded-full shadow-lg hover:scale-105 transition-transform flex items-center gap-2 animate-pulse"
            >
                <Zap size={24} fill="currentColor" />
                <span className="font-bold hidden md:inline uppercase tracking-wider text-sm">Lançar Vaga</span>
            </button>

            {/* Modal Drawer */}
            {isOpen && (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in">
                    <div className="w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl p-6 overflow-y-auto animate-in slide-in-from-right duration-300 flex flex-col">

                        {/* Header */}
                        <div className="flex justify-between items-center mb-8">
                            <h2 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-2 uppercase tracking-tight">
                                <Zap className="text-orange-500" size={28} />
                                Lançador
                            </h2>
                            <button onClick={() => setIsOpen(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                                <X size={24} className="text-slate-400" />
                            </button>
                        </div>

                        <div className="flex-1 space-y-8">

                            {/* Student Info */}
                            <div className="space-y-4">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                    <User size={14} /> Dados do Lead
                                </p>
                                <input
                                    value={studentName}
                                    onChange={(e) => setStudentName(e.target.value)}
                                    placeholder="Nome do Aluno (Ex: João)"
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-xl font-medium text-slate-900 dark:text-white focus:border-orange-500 focus:ring-0 transition-colors"
                                />
                                <div className="relative">
                                    <input
                                        value={studentPhone}
                                        onChange={(e) => setStudentPhone(e.target.value)}
                                        placeholder="WhatsApp (Ex: 5511999999999)"
                                        className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-xl font-medium text-slate-900 dark:text-white focus:border-orange-500 focus:ring-0 transition-colors"
                                    />
                                    <Phone className="absolute left-3 top-3.5 text-slate-400" size={18} />
                                </div>
                                <textarea
                                    value={studentInterests}
                                    onChange={(e) => setStudentInterests(e.target.value)}
                                    placeholder="Interesse / Objetivo (Ex: Inglês para viagem, Reforço escolar...)"
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-xl font-medium text-slate-900 dark:text-white focus:border-orange-500 focus:ring-0 transition-colors resize-none h-24"
                                />
                            </div>

                            {/* Date & Time Slot */}
                            <div className="space-y-4">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                    <Clock size={14} /> Data e Horário
                                </p>

                                <div className="grid grid-cols-2 gap-4">
                                    {/* Date Picker */}
                                    <div className="relative">
                                        <input
                                            type="date"
                                            value={targetDate}
                                            onChange={(e) => setTargetDate(e.target.value)}
                                            className="w-full pl-10 pr-4 py-4 bg-slate-50 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-2xl font-bold text-slate-900 dark:text-white focus:border-orange-500 focus:ring-0 transition-colors"
                                        />
                                        <Calendar className="absolute left-3 top-4.5 text-slate-400" size={20} />
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

                        </div>

                        {/* Action Button */}
                        <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800">
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
                            <p className="text-center text-[10px] text-slate-400 mt-3 font-medium">
                                Envia para todos os professores conectados a '{localStorage.getItem('whatsapp_instance') || "wise wolf"}'.
                            </p>
                        </div>

                    </div>
                </div>
            )}
        </>
    );
};

export default SmartFinder;
