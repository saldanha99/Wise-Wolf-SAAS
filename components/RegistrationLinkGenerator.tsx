import React, { useState, useEffect } from 'react';
import {
    Link as LinkIcon, Copy, Check, Calendar, Clock, BookOpen, Users,
    Rocket, Sparkles, GraduationCap, ChevronDown, Wallet, Search, Loader2
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { createSignedOffer } from '../services/offerService';

interface RegistrationLinkGeneratorProps {
    tenantId: string | undefined;
    teachers?: any[];
    vendorId?: string; // ID do vendedor para rastreamento de comissão
}

// Business Rules Configuration
const PRICING_TABLE: Record<number, Record<number, number>> = {
    // Fidelidade 12 Meses (Anual)
    12: {
        2: 139.90, // 2 aulas/semana
        3: 187.00, // 3 aulas/semana
        4: 271.00, // 4 aulas/semana
        5: 297.00  // 5 aulas/semana
    },
    // Fidelidade 6 Meses (Semestral)
    6: {
        2: 188.00,
        3: 251.00,
        4: 345.00,
        5: 366.00
    },
    // Mensal (Exemplo - Adicionado para completar a UI)
    1: {
        2: 220.00,
        3: 290.00,
        4: 390.00,
        5: 450.00
    }
};

const RegistrationLinkGenerator: React.FC<RegistrationLinkGeneratorProps> = ({ tenantId, teachers = [], vendorId }) => {
    // Form State
    const [duration, setDuration] = useState<number>(12); // 12, 6, 1
    const [frequency, setFrequency] = useState<number>(2); // 2, 3, 4, 5
    const [dueDay, setDueDay] = useState(10);
    const [monthlyFee, setMonthlyFee] = useState(0);
    const [chargeEnrollmentFee, setChargeEnrollmentFee] = useState(true);
    const [enrollmentFee, setEnrollmentFee] = useState(49);

    // Academic State
    const [professors, setProfessors] = useState<any[]>([]);
    const [selectedProfessor, setSelectedProfessor] = useState('');
    const [professorSearch, setProfessorSearch] = useState('');
    const [showProfessorList, setShowProfessorList] = useState(false);

    // Optional second professor
    const [selectedProfessor2, setSelectedProfessor2] = useState('');
    const [professorSearch2, setProfessorSearch2] = useState('');
    const [showProfessorList2, setShowProfessorList2] = useState(false);

    // Schedule Array State
    const [scheduleSlots, setScheduleSlots] = useState<{ day: string; time: string }[]>(
        Array(2).fill({ day: '', time: '' })
    );

    // Date State
    const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);

    // Pro-rata & billing start month
    const [enableProRata, setEnableProRata] = useState(false);
    const [billingStartMonth, setBillingStartMonth] = useState(() => {
        const now = new Date();
        if (now.getDate() > 15) now.setMonth(now.getMonth() + 1);
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

    // Link State
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);

    // Manual Price State
    const [isManualPrice, setIsManualPrice] = useState(false);

    // Auto-calculate price
    useEffect(() => {
        if (isManualPrice) return;
        const price = PRICING_TABLE[duration]?.[frequency] || 0;
        setMonthlyFee(price);
    }, [duration, frequency, isManualPrice]);

    // Update slots when frequency changes
    useEffect(() => {
        setScheduleSlots(prev => {
            const newSlots = [...prev];
            if (frequency > prev.length) {
                const toAdd = frequency - prev.length;
                for (let i = 0; i < toAdd; i++) newSlots.push({ day: '', time: '' });
            } else if (frequency < prev.length) {
                newSlots.splice(frequency);
            }
            return newSlots;
        });
    }, [frequency]);

    // Fetch Professors (or use prop)
    useEffect(() => {
        if (teachers && teachers.length > 0) {
            setProfessors(teachers);
            return;
        }

        if (!tenantId) return;

        const fetchProfessors = async () => {
            const { data } = await supabase
                .from('profiles')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .in('role', ['TEACHER', 'teacher']); // Fallback fetch

            if (data) setProfessors(data);
        };
        fetchProfessors();
    }, [tenantId, teachers]);

    const updateSlot = (index: number, field: 'day' | 'time', value: string) => {
        setScheduleSlots(prev => {
            const newSlots = [...prev];
            const oldFirstTime = prev[0].time;
            
            newSlots[index] = { ...newSlots[index], [field]: value };
            
            // Smart Auto-fill: Sync time changes from the first slot to downstream slots
            if (index === 0 && field === 'time') {
                for (let i = 1; i < newSlots.length; i++) {
                    // Only overwrite if it's empty OR hasn't been manually diverged yet
                    if (!prev[i].time || prev[i].time === oldFirstTime) {
                        newSlots[i] = { ...newSlots[i], time: value };
                    }
                }
            }
            
            return newSlots;
        });
    };

    const generateLink = async () => {
        if (!tenantId) return alert("Erro: ID da unidade não encontrado.");
        if (monthlyFee <= 0) return alert("Erro: Valor inválido.");

        setGenerating(true);
        try {
            // Filter valid schedule slots
            const validSchedule = scheduleSlots.filter(s => s.day && s.time);

        // Calculate pro-rata value
        const todayPR = new Date();
        const proRataValue = enableProRata ? (() => {
            const daysInMonth = new Date(todayPR.getFullYear(), todayPR.getMonth() + 1, 0).getDate();
            const remainingDays = daysInMonth - todayPR.getDate() + 1;
            return Math.round((monthlyFee / daysInMonth) * remainingDays * 100) / 100;
        })() : 0;

        const payload = {
            unitId: tenantId,
            value: monthlyFee,
            planDuration: duration,
            classesPerWeek: frequency,
            dueDay: dueDay,
            professorId: selectedProfessor || null,
            professorId2: selectedProfessor2 || null,
            schedule: validSchedule.length > 0 ? validSchedule : null,
            startDate: startDate,
            requiresEnrollment: duration !== 0,
            enrollmentFee: chargeEnrollmentFee ? enrollmentFee : 0,
            enableProRata,
            proRataValue: enableProRata ? proRataValue : undefined,
            billingStartMonth,
            vendorId: vendorId || null
        };

        const result = await createSignedOffer({
            kind: 'ENROLLMENT',
            payload,
            tenantId,
            expiresIn: '30d',
        });

            setGeneratedLink(result.url);
            setCopied(false);
        } catch (err) {
            console.error('Failed to generate signed link:', err);
            alert('Erro ao gerar link. Tente novamente.');
        } finally {
            setGenerating(false);
        }
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Validation for Button Availability
    const isFormValid = monthlyFee > 0;

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden font-sans">

            {/* Header */}
            <div className="bg-gradient-to-r from-[#002366] to-blue-900 p-8 text-white relative overflow-hidden">
                <div className="relative z-10 flex items-center justify-between">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <Rocket className="text-blue-300 animate-pulse" size={24} />
                            <h2 className="text-2xl font-black tracking-tight">Gerar Acesso do Aluno</h2>
                        </div>
                        <p className="text-blue-100/80 text-sm font-medium max-w-md">
                            Configure os termos financeiros e acadêmicos para criar o contrato digital personalizado.
                        </p>
                    </div>
                    {/* Decorative Price Badge */}
                    <div className="hidden md:flex flex-col items-end bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
                        <span className="text-[10px] uppercase font-bold tracking-widest text-blue-200 mb-1">Valor Final</span>
                        <div className="text-3xl font-black tracking-tighter">
                            R$ {monthlyFee.toFixed(2)}
                            <span className="text-sm font-bold text-blue-300 ml-1">/mês</span>
                        </div>
                    </div>
                </div>
                {/* Background Decor */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-0 w-40 h-40 bg-purple-500/20 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
            </div>

            <div className="p-8 space-y-8">

                {/* SECTION 1: O PLANO */}
                <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                        <Wallet size={14} /> Selecione o Plano e Frequência
                    </h3>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Plan Duration Cards */}
                        <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-4">
                            {[
                                { val: 12, label: 'Anual', sub: 'Fidelidade 12 Meses' },
                                { val: 6, label: 'Semestral', sub: 'Fidelidade 6 Meses' },
                                { val: 1, label: 'Mensal', sub: 'Sem Fidelidade' },
                                { val: 0, label: 'Avulso', sub: 'Aula Única' }
                            ].map((plan) => (
                                <button
                                    key={plan.val}
                                    onClick={() => setDuration(plan.val)}
                                    className={`relative p-4 rounded-2xl border-2 text-left transition-all duration-300 hover:scale-[1.02] ${duration === plan.val
                                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-600 ring-offset-2 dark:ring-offset-slate-900'
                                        : 'border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-400 hover:border-slate-200'
                                        }`}
                                >
                                    {duration === plan.val && (
                                        <div className="absolute -top-2 -right-2 bg-blue-600 text-white p-1 rounded-full shadow-sm">
                                            <Check size={12} strokeWidth={4} />
                                        </div>
                                    )}
                                    <span className={`block text-lg font-black ${duration === plan.val ? 'text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`}>
                                        {plan.label}
                                    </span>
                                    <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">
                                        {plan.sub}
                                    </span>
                                </button>
                            ))}
                        </div>

                        {/* Frequency & Due Day Controls */}
                        <div className="space-y-4">
                            <div className="flex gap-4">
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Frequência Semanal</label>
                                    <div className="relative">
                                        <select
                                            value={frequency}
                                            onChange={(e) => setFrequency(Number(e.target.value))}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-slate-700 dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}x na Semana</option>)}
                                        </select>
                                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
                                    </div>
                                </div>
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Vencimento</label>
                                    <div className="relative">
                                        <select
                                            value={dueDay}
                                            onChange={(e) => setDueDay(Number(e.target.value))}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-slate-700 dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                                                <option key={d} value={d}>Dia {d}</option>
                                            ))}
                                        </select>
                                        <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
                                    </div>
                                </div>
                            </div>

                            {/* Start Date Control */}
                            <div>
                                <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Início das Aulas</label>
                                <div className="relative">
                                    <input
                                        type="date"
                                        value={startDate}
                                        onChange={(e) => setStartDate(e.target.value)}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-slate-700 dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                    <Clock className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
                                </div>
                            </div>

                            {/* Manual Price Override */}
                            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                                <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-slate-400 mb-2 cursor-pointer hover:text-blue-500 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={isManualPrice}
                                        onChange={(e) => setIsManualPrice(e.target.checked)}
                                        className="rounded text-blue-600 focus:ring-blue-500"
                                    />
                                    Definir Preço Manual / Desconto
                                </label>

                                {isManualPrice && (
                                    <div className="relative animate-in fade-in slide-in-from-top-2">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">R$</span>
                                        <input
                                            type="number"
                                            value={monthlyFee}
                                            onChange={(e) => setMonthlyFee(Number(e.target.value))}
                                            className="w-full pl-10 pr-4 py-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl font-black text-blue-700 dark:text-blue-300 outline-none focus:ring-2 focus:ring-blue-500"
                                            placeholder="0.00"
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Mobile Price View */}
                            <div className="md:hidden p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-100 dark:border-emerald-800 flex justify-between items-center text-emerald-700">
                                <span className="text-xs font-bold uppercase">Total Mensal</span>
                                <span className="font-black text-lg">R$ {monthlyFee.toFixed(2)}</span>
                            </div>

                            {/* Enrollment Fee Control */}
                            <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-slate-400 cursor-pointer hover:text-blue-500 transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={chargeEnrollmentFee}
                                            onChange={(e) => setChargeEnrollmentFee(e.target.checked)}
                                            className="rounded text-blue-600 focus:ring-blue-500"
                                        />
                                        Cobrar Taxa de Matrícula
                                    </label>
                                    {chargeEnrollmentFee && (
                                        <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-900/40 px-3 py-1 rounded-lg border border-blue-100 dark:border-blue-800">
                                            <span className="text-[10px] font-black text-blue-600 dark:text-blue-400">R$</span>
                                            <input
                                                type="number"
                                                value={enrollmentFee}
                                                onChange={(e) => setEnrollmentFee(Number(e.target.value))}
                                                className="w-12 bg-transparent border-none p-0 text-sm font-black text-blue-700 dark:text-blue-300 outline-none focus:ring-0"
                                            />
                                        </div>
                                    )}
                                </div>
                                <p className="text-[9px] text-slate-400 font-medium">
                                    {chargeEnrollmentFee 
                                        ? `O aluno deverá pagar R$ ${enrollmentFee.toFixed(2)} via Pix para garantir a vaga.`
                                        : 'A taxa de matrícula não será cobrada neste link.'}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* PRO-RATA & BILLING START */}
                <div className="bg-amber-50 dark:bg-amber-900/10 rounded-2xl p-6 border border-amber-100 dark:border-amber-800/30">
                    <h3 className="text-xs font-black text-amber-700 dark:text-amber-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                        <Calendar size={14} /> Início de Cobrança (Opcional)
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Mês de início da mensalidade</label>
                            <input
                                type="month"
                                value={billingStartMonth}
                                onChange={(e) => setBillingStartMonth(e.target.value)}
                                className="w-full px-4 py-3 bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-700 rounded-xl font-bold text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-amber-500"
                            />
                            <p className="text-[9px] text-slate-400 mt-1">Escolha um mês futuro para diferir o início da cobrança recorrente.</p>
                        </div>
                        <div className="flex flex-col justify-center gap-2">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <div className="relative flex-shrink-0">
                                    <input type="checkbox" checked={enableProRata} onChange={(e) => setEnableProRata(e.target.checked)} className="sr-only" />
                                    <div className={`w-10 h-6 rounded-full transition-colors ${enableProRata ? 'bg-amber-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                                    <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${enableProRata ? 'translate-x-4' : ''}`} />
                                </div>
                                <div>
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Cobrar Pro-Rata</p>
                                    <p className="text-[9px] text-slate-400">Cobrança proporcional pelos dias do mês atual</p>
                                </div>
                            </label>
                            {enableProRata && monthlyFee > 0 && (
                                <div className="ml-13 pl-14 text-xs font-black text-amber-600 dark:text-amber-400">
                                    Valor proporcional: R$ {(() => {
                                        const d = new Date();
                                        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
                                        return ((monthlyFee / dim) * (dim - d.getDate() + 1)).toFixed(2);
                                    })()}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* SECTION 2: ALOCAÇÃO ACADÊMICA */}
                <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-6 border border-slate-200 dark:border-slate-700/50 !overflow-visible">
                    <div className="flex items-center gap-2 mb-6">
                        <div className="p-2 bg-white dark:bg-slate-700 rounded-lg shadow-sm">
                            <GraduationCap size={18} className="text-purple-600 dark:text-purple-400" />
                        </div>
                        <h3 className="text-sm font-black text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                            Alocação Acadêmica
                        </h3>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 !overflow-visible">
                        {/* Professor Select (Searchable) */}
                        <div className="lg:col-span-1 relative z-50 flex flex-col gap-4">
                            <div>
                                <label className="text-[10px] font-bold uppercase text-slate-400 mb-2 block">Selecionar Professor</label>

                                <div className="relative group">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-purple-500 transition-colors" size={16} />
                                    <input
                                        type="text"
                                        placeholder="Buscar Professor..."
                                        value={selectedProfessor ? (professors.find(p => p.id === selectedProfessor)?.name || '') : professorSearch}
                                        onChange={(e) => {
                                            setProfessorSearch(e.target.value);
                                            setSelectedProfessor(''); // Clear selection on type
                                            setShowProfessorList(true);
                                        }}
                                        onFocus={() => {
                                            setProfessorSearch('');
                                            setShowProfessorList(true);
                                        }}
                                        onClick={() => {
                                            setProfessorSearch('');
                                            setShowProfessorList(true);
                                        }}
                                        className="w-full pl-10 pr-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all shadow-sm cursor-pointer"
                                    />
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
                                </div>

                                {/* Dropdown List */}
                                {showProfessorList && (
                                    <>
                                        <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => setShowProfessorList(false)}
                                        />
                                        <div className="absolute top-full left-0 right-0 min-w-[280px] mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-[9999] animate-in fade-in zoom-in-95 duration-200 custom-scrollbar">
                                            {professors.filter(p => !professorSearch || p.name.toLowerCase().includes(professorSearch.toLowerCase())).length > 0 ? (
                                                professors
                                                    .filter(p => !professorSearch || p.name.toLowerCase().includes(professorSearch.toLowerCase()))
                                                    .map(p => (
                                                        <button
                                                            key={p.id}
                                                            onClick={() => {
                                                                setSelectedProfessor(p.id);
                                                                setShowProfessorList(false);
                                                                setProfessorSearch('');
                                                            }}
                                                            className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors flex items-center justify-between"
                                                        >
                                                            {p.name}
                                                            {selectedProfessor === p.id && <Check size={14} className="text-purple-500" />}
                                                        </button>
                                                    ))
                                            ) : (
                                                <div className="p-4 text-center text-slate-400 text-xs">
                                                    Nenhum professor encontrado.
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div>
                                <label className="text-[10px] font-bold uppercase text-slate-400 mb-2 block">Professor Secundário (Opcional)</label>

                                <div className="relative group">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-purple-500 transition-colors" size={16} />
                                    <input
                                        type="text"
                                        placeholder="Buscar Professor 2..."
                                        value={selectedProfessor2 ? (professors.find(p => p.id === selectedProfessor2)?.name || '') : professorSearch2}
                                        onChange={(e) => {
                                            setProfessorSearch2(e.target.value);
                                            setSelectedProfessor2('');
                                            setShowProfessorList2(true);
                                        }}
                                        onFocus={() => {
                                            setProfessorSearch2('');
                                            setShowProfessorList2(true);
                                        }}
                                        onClick={() => {
                                            setProfessorSearch2('');
                                            setShowProfessorList2(true);
                                        }}
                                        className="w-full pl-10 pr-4 py-3 bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-600 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all shadow-sm cursor-pointer"
                                    />
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
                                </div>

                                {/* Dropdown List 2 */}
                                {showProfessorList2 && (
                                    <>
                                        <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => setShowProfessorList2(false)}
                                        />
                                        <div className="absolute top-full left-0 right-0 min-w-[280px] mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-[9999] animate-in fade-in zoom-in-95 duration-200 custom-scrollbar">
                                            {professors.filter(p => !professorSearch2 || p.name.toLowerCase().includes(professorSearch2.toLowerCase())).length > 0 ? (
                                                professors
                                                    .filter(p => !professorSearch2 || p.name.toLowerCase().includes(professorSearch2.toLowerCase()))
                                                    .map(p => (
                                                        <button
                                                            key={`prof2-${p.id}`}
                                                            onClick={() => {
                                                                setSelectedProfessor2(p.id);
                                                                setShowProfessorList2(false);
                                                                setProfessorSearch2('');
                                                            }}
                                                            className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors flex items-center justify-between"
                                                        >
                                                            {p.name}
                                                            {selectedProfessor2 === p.id && <Check size={14} className="text-purple-500" />}
                                                        </button>
                                                    ))
                                            ) : (
                                                <div className="p-4 text-center text-slate-400 text-xs">
                                                    Nenhum professor encontrado.
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Schedule Grid */}
                        <div className="lg:col-span-3">
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-2 block">
                                Grade Horária ({frequency}x na Semana)
                            </label>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                {scheduleSlots.map((slot, index) => (
                                    <div key={index} className="flex items-center gap-2 bg-white dark:bg-slate-900 p-2 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm group hover:border-purple-300 transition-colors">
                                        <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-bold text-xs shrink-0">
                                            {index + 1}
                                        </div>
                                        <select
                                            value={slot.day}
                                            onChange={e => updateSlot(index, 'day', e.target.value)}
                                            className="w-28 bg-transparent text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none"
                                        >
                                            <option value="">Dia</option>
                                            <option value="Monday">Segunda</option>
                                            <option value="Tuesday">Terça</option>
                                            <option value="Wednesday">Quarta</option>
                                            <option value="Thursday">Quinta</option>
                                            <option value="Friday">Sexta</option>
                                            <option value="Saturday">Sábado</option>
                                        </select>
                                        <div className="w-[1px] h-4 bg-slate-200 dark:bg-slate-700" />
                                        <input
                                            type="time"
                                            value={slot.time}
                                            onChange={e => updateSlot(index, 'time', e.target.value)}
                                            className="w-full bg-transparent text-xs font-mono font-medium text-slate-700 dark:text-slate-200 outline-none"
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* SECTION 3: MAGIC LINK AREA */}
                <div className={`transition-all duration-500 ${generatedLink ? 'opacity-100 translate-y-0' : ''}`}>
                    <button
                        onClick={generateLink}
                        disabled={!isFormValid}
                        className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-blue-500/20 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 group"
                    >
                        <Sparkles size={18} className="group-hover:animate-spin-slow" />
                        Gerar Link Mágico
                    </button>

                    {generatedLink && (
                        <div className="mt-6 animate-in fade-in slide-in-from-top-4">
                            <div className="bg-slate-900 rounded-2xl p-4 flex items-center gap-4 border border-slate-800 shadow-2xl">
                                <LinkIcon size={20} className="text-emerald-400 shrink-0" />
                                <div className="flex-1 overflow-hidden">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Link Gerado com Sucesso
                                    </p>
                                    <input
                                        readOnly
                                        value={generatedLink}
                                        className="w-full bg-transparent border-none p-0 text-sm font-mono text-emerald-400 focus:ring-0 truncate"
                                    />
                                </div>
                                <button
                                    onClick={copyToClipboard}
                                    className={`px-4 py-2 rounded-lg font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${copied
                                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                                        }`}
                                >
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                    {copied ? 'Copiado!' : 'Copiar'}
                                </button>
                            </div>
                            <p className="text-center text-[10px] text-slate-400 mt-3 font-medium">
                                * Este link expira automaticamente se as regras de negócio forem alteradas.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RegistrationLinkGenerator;
