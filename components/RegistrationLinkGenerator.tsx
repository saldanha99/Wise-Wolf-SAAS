import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    Link as LinkIcon, Copy, Check, Calendar, Clock, BookOpen, Users,
    Rocket, Sparkles, GraduationCap, ChevronDown, Wallet, Search, AlertCircle, Loader2
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { pricingService, PricingMatrix } from '../services/pricingService';
import { isValidBrazilianMobile, normalizeEnrollmentProRataTerms } from '../lib/enrollment';
import EnrollmentProRataSwitch from './EnrollmentProRataSwitch';
import {
    calculateEnrollmentProRataPreview,
    dateInSaoPaulo,
    defaultBillingStartMonthInSaoPaulo,
    enrollmentOfferErrorMessage,
    normalizeEnrollmentTime,
    weekdayIndex,
} from '../lib/enrollmentOffer';

interface RegistrationLinkGeneratorProps {
    tenantId: string | undefined;
    teachers?: any[];
    vendorId?: string; // ID do vendedor para rastreamento de comissão
}

const RegistrationLinkGenerator: React.FC<RegistrationLinkGeneratorProps> = ({ tenantId, teachers = [], vendorId }) => {
    // Form State
    const [duration, setDuration] = useState<number>(12); // 12, 6, 1
    const [frequency, setFrequency] = useState<number>(2); // 2, 3, 4, 5
    const [dueDay, setDueDay] = useState(10);
    const [monthlyFee, setMonthlyFee] = useState(0);
    const [chargeEnrollmentFee, setChargeEnrollmentFee] = useState(true);
    const [enrollmentFee, setEnrollmentFee] = useState(49);
    const [studentLevel, setStudentLevel] = useState('A1');

    // Academic State
    const [professors, setProfessors] = useState<any[]>([]);
    const [selectedProfessor, setSelectedProfessor] = useState('');
    const [professorSearch, setProfessorSearch] = useState('');
    const [showProfessorList, setShowProfessorList] = useState(false);

    // Optional second professor
    const [selectedProfessor2, setSelectedProfessor2] = useState('');
    const [professorSearch2, setProfessorSearch2] = useState('');
    const [showProfessorList2, setShowProfessorList2] = useState(false);

    // Matrícula de dependente: cobrança no CPF de um responsável financeiro já cadastrado
    const [isDependent, setIsDependent] = useState(false);
    const [studentPhone, setStudentPhone] = useState(''); // WhatsApp de quem assiste a aula (dependente)
    const [guardianCandidates, setGuardianCandidates] = useState<any[]>([]);
    const [guardianSearch, setGuardianSearch] = useState('');
    const [showGuardianList, setShowGuardianList] = useState(false);
    const [selectedGuardianId, setSelectedGuardianId] = useState('');
    const selectedGuardian = guardianCandidates.find(g => g.id === selectedGuardianId) || null;

    // Schedule Array State
    const [scheduleSlots, setScheduleSlots] = useState<{ day: string; time: string; teacherId: string }[]>(
        Array.from({ length: 2 }, () => ({ day: '', time: '', teacherId: '' }))
    );

    // Date State
    const [startDate, setStartDate] = useState(dateInSaoPaulo());

    // Pro-rata & billing start month
    const [enableProRata, setEnableProRata] = useState(false);
    const [billingStartMonth, setBillingStartMonth] = useState(defaultBillingStartMonthInSaoPaulo);
    const proRataEnabled = normalizeEnrollmentProRataTerms({
        enableProRata,
        planDuration: duration,
    }).enabled;

    // Link State
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);
    const offerRequestIds = useRef<Record<string, string>>({});
    const [formError, setFormError] = useState('');
    const [availabilityLoading, setAvailabilityLoading] = useState(false);
    const [availabilityRows, setAvailabilityRows] = useState<Array<{
        teacher_id: string; day_of_week: number; start_time: string; end_time?: string | null;
    }>>([]);
    const [busyRows, setBusyRows] = useState<Array<{
        teacher_id: string; day_of_week: string; time_slot: string;
    }>>([]);

    // Manual Price State
    const [isManualPrice, setIsManualPrice] = useState(false);

    // Pricing carregado do banco (com fallback hardcoded)
    const [pricingMatrix, setPricingMatrix] = useState<PricingMatrix>(pricingService.FALLBACK_PRICING);

    useEffect(() => {
        if (!tenantId) return;
        pricingService.loadPricing(tenantId).then(setPricingMatrix);
    }, [tenantId]);

    // Auto-calculate price
    useEffect(() => {
        if (isManualPrice) return;
        const price = pricingMatrix[duration]?.[frequency] || 0;
        setMonthlyFee(price);
    }, [duration, frequency, isManualPrice, pricingMatrix]);

    // Se qualquer termo mudar, o link exibido deixa de representar o formulário
    // atual e precisa ser gerado novamente.
    useEffect(() => {
        setGeneratedLink('');
        setCopied(false);
        setFormError('');
    }, [
        duration, frequency, dueDay, monthlyFee, chargeEnrollmentFee, enrollmentFee,
        selectedProfessor, selectedProfessor2, isDependent, studentPhone,
        selectedGuardianId, scheduleSlots, startDate, enableProRata, billingStartMonth,
        studentLevel,
    ]);

    // Update slots when frequency changes
    useEffect(() => {
        setScheduleSlots(prev => {
            const newSlots = [...prev];
            if (frequency > prev.length) {
                const toAdd = frequency - prev.length;
                for (let i = 0; i < toAdd; i++) newSlots.push({ day: '', time: '', teacherId: selectedProfessor });
            } else if (frequency < prev.length) {
                newSlots.splice(frequency);
            }
            return newSlots;
        });
    }, [frequency, selectedProfessor]);

    useEffect(() => {
        const teacherIds = [selectedProfessor, selectedProfessor2].filter(Boolean);
        if (teacherIds.length === 0 || !tenantId) {
            setAvailabilityRows([]);
            setBusyRows([]);
            return;
        }
        let cancelled = false;
        setAvailabilityLoading(true);
        (async () => {
            const [availability, bookings] = await Promise.all([
                supabase.from('teacher_availability')
                    .select('teacher_id,day_of_week,start_time,end_time')
                    .eq('tenant_id', tenantId)
                    .in('teacher_id', teacherIds),
                supabase.from('bookings')
                    .select('teacher_id,day_of_week,time_slot')
                    .eq('tenant_id', tenantId)
                    .in('teacher_id', teacherIds)
                    .in('status', ['SCHEDULED', 'scheduled']),
            ]);
            if (cancelled) return;
            if (availability.error || bookings.error) {
                setFormError('Não foi possível confirmar a agenda dos professores. Recarregue e tente novamente.');
                setAvailabilityRows([]);
                setBusyRows([]);
            } else {
                setAvailabilityRows((availability.data || []) as typeof availabilityRows);
                setBusyRows((bookings.data || []) as typeof busyRows);
            }
            setAvailabilityLoading(false);
        })();
        return () => { cancelled = true; };
    }, [tenantId, selectedProfessor, selectedProfessor2]);

    // Fetch Professors (or use prop)
    useEffect(() => {
        if (teachers && teachers.length > 0) {
            setProfessors(teachers.map(teacher => ({
                ...teacher,
                name: teacher.name || teacher.full_name || 'Professor',
            })));
            return;
        }

        if (!tenantId) return;

        const fetchProfessors = async () => {
            const { data } = await supabase
                .from('profiles')
                .select('id, full_name')
                .eq('tenant_id', tenantId)
                .in('role', ['TEACHER', 'teacher']); // Fallback fetch

            if (data) setProfessors(data.map(teacher => ({ ...teacher, name: teacher.full_name })));
        };
        fetchProfessors();
    }, [tenantId, teachers]);

    // Busca responsáveis já cadastrados (perfis com CPF) para vincular o dependente
    useEffect(() => {
        if (!isDependent || !tenantId || guardianCandidates.length > 0) return;
        (async () => {
            const { data, error } = await supabase.rpc(
                'get_authorized_guardian_directory',
                { p_tenant_id: tenantId },
            );
            if (error) {
                console.error('Não foi possível carregar responsáveis autorizados:', error);
                return;
            }
            if (data) setGuardianCandidates(data);
        })();
    }, [isDependent, tenantId]);

    const updateSlot = (index: number, field: 'day' | 'time' | 'teacherId', value: string) => {
        setScheduleSlots(prev => {
            const newSlots = [...prev];
            const oldFirstTime = prev[0].time;

            newSlots[index] = {
                ...newSlots[index],
                [field]: value,
                ...((field === 'day' || field === 'teacherId') ? { time: '' } : {}),
            };
            
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

    const isBusy = (teacherId: string, day: string, time: string) => busyRows.some(row =>
        row.teacher_id === teacherId
        && weekdayIndex(row.day_of_week) === weekdayIndex(day)
        && normalizeEnrollmentTime(row.time_slot) === normalizeEnrollmentTime(time)
    );

    const availableTimes = (teacherId: string, day: string) => {
        const targetDay = weekdayIndex(day);
        if (!teacherId || targetDay === null) return [];
        const times = availabilityRows
            .filter(row => row.teacher_id === teacherId && Number(row.day_of_week) === targetDay)
            .map(row => normalizeEnrollmentTime(row.start_time))
            .filter((time): time is string => Boolean(time))
            .filter(time => !isBusy(teacherId, day, time));
        return [...new Set(times)].sort();
    };

    const proRataPreview = useMemo(() => calculateEnrollmentProRataPreview({
        enabled: proRataEnabled,
        monthlyFee,
        classesPerWeek: frequency,
        dueDay,
        billingStartMonth,
        startDate,
        schedule: scheduleSlots,
    }), [proRataEnabled, monthlyFee, frequency, dueDay, billingStartMonth, startDate, scheduleSlots]);

    const generateLink = async () => {
        setFormError('');
        if (!tenantId) return setFormError('A unidade ativa não foi identificada. Recarregue a página.');
        if (monthlyFee <= 0) return setFormError('Informe um valor mensal válido.');
        if (!selectedProfessor) return setFormError('Selecione o professor principal.');
        if (selectedProfessor2 && selectedProfessor2 === selectedProfessor) {
            return setFormError('O professor secundário precisa ser diferente do principal.');
        }
        if (scheduleSlots.length !== frequency || scheduleSlots.some(slot => !slot.day || !slot.time)) {
            return setFormError(`Preencha exatamente ${frequency} horários para o plano ${frequency}x por semana.`);
        }
        const validTeachers = new Set([selectedProfessor, selectedProfessor2].filter(Boolean));
        if (scheduleSlots.some(slot => !validTeachers.has(slot.teacherId || selectedProfessor))) {
            return setFormError('Escolha um professor válido em cada horário.');
        }
        // O aluno tambem nao pode ter duas aulas simultaneas, ainda que sejam
        // com professores diferentes.
        const scheduleKeys = scheduleSlots.map(slot =>
            `${weekdayIndex(slot.day)}|${normalizeEnrollmentTime(slot.time)}`
        );
        if (new Set(scheduleKeys).size !== scheduleKeys.length) {
            return setFormError('A grade contém um horário repetido. Escolha slots distintos.');
        }
        if (scheduleSlots.some(slot =>
            !availableTimes(slot.teacherId || selectedProfessor, slot.day).includes(slot.time)
        )) {
            return setFormError('Um dos horários não está mais disponível para o professor escolhido. Atualize a grade.');
        }
        if (isDependent && !selectedGuardian) {
            return setFormError('Selecione o responsável financeiro para a matrícula de dependente.');
        }
        if (isDependent && !isValidBrazilianMobile(studentPhone)) {
            return setFormError('Informe um WhatsApp válido do aluno, com DDD. A cobrança continuará no responsável.');
        }

        const validSchedule = scheduleSlots.map(slot => ({
            day: slot.day,
            time: slot.time,
            teacherId: slot.teacherId || selectedProfessor,
        }));

        const data = {
            unitId: tenantId,
            value: monthlyFee,
            planDuration: duration,
            classesPerWeek: frequency,
            dueDay: dueDay,
            module: studentLevel,
            professorId: selectedProfessor || null,
            professorId2: selectedProfessor2 || null,
            schedule: validSchedule.length > 0 ? validSchedule : null,
            startDate: startDate,
            requiresEnrollment: duration !== 0,
            enrollmentFee: chargeEnrollmentFee ? enrollmentFee : 0,
            // Módulo 3 - Pro-rata + billing start month
            enableProRata: proRataEnabled,
            billingStartMonth,
            // Módulo 1 - Vendor commission tracking
            vendorId: vendorId || null,
            // Matrícula de dependente: cobrança no CPF do responsável financeiro
            isDependent: isDependent && !!selectedGuardian,
            // Telefone de quem ASSISTE a aula (confirmação de presença) — separado do responsável (cobrança).
            studentPhone: studentPhone ? studentPhone.replace(/\D/g, '') : null,
            guardianId: selectedGuardian?.id || null,
            guardianCpf: selectedGuardian?.cpf || null,
            guardianName: selectedGuardian?.full_name || null,
            guardianEmail: selectedGuardian?.email || null,
            guardianPhone: selectedGuardian?.phone || null,
            guardianPostalCode: selectedGuardian?.postal_code || null,
            guardianAddress: selectedGuardian?.address || null,
            guardianAddressNumber: selectedGuardian?.address_number || null,
        };

        // Link assinado: grava o payload AUTORITATIVO (preço, cobrança, dados do
        // responsável) num offer server-side e leva só o offer_id no URL — assim o
        // aluno não consegue editar o preço pelo link. Se a RPC falhar, nao geramos
        // um link inseguro: o usuario recebe o erro e pode tentar novamente.
        try {
            setGenerating(true);
            const requestKey = JSON.stringify(data);
            const requestId = offerRequestIds.current[requestKey] || crypto.randomUUID();
            offerRequestIds.current[requestKey] = requestId;
            const { data: offerId, error: offerErr } = await supabase.rpc('create_enrollment_offer', {
                p_payload: { ...data, requestId },
            });
            if (offerErr || !offerId) throw offerErr || new Error('offer id vazio');
            delete offerRequestIds.current[requestKey];
            setGeneratedLink(`${APP_BASE_URL}/matricula?offer=${offerId}`);
        } catch (e) {
            console.error('create_enrollment_offer falhou:', e);
            setGeneratedLink('');
            setFormError(enrollmentOfferErrorMessage(e));
            return;
        } finally {
            setGenerating(false);
        }
        setCopied(false);
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Validation for Button Availability
    const isFormValid = monthlyFee > 0 && Boolean(selectedProfessor) && !generating;

    return (
        <div className="bg-brand-surface rounded-[2.5rem] shadow-xl border border-brand-border overflow-hidden font-sans">

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
                    <div className="hidden md:flex flex-col items-end bg-brand-surface/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
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
                    <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2 mb-4">
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
                                    onClick={() => {
                                        setDuration(plan.val);
                                        if (plan.val === 0) setEnableProRata(false);
                                    }}
                                    className={`relative p-4 rounded-2xl border-2 text-left transition-all duration-300 hover:scale-[1.02] ${duration === plan.val
                                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-600 ring-offset-2 dark:ring-offset-slate-900'
                                        : 'border-brand-border bg-brand-surface-2 text-brand-muted hover:border-brand-border'
                                        }`}
                                >
                                    {duration === plan.val && (
                                        <div className="absolute -top-2 -right-2 bg-blue-600 text-white p-1 rounded-full shadow-sm">
                                            <Check size={12} strokeWidth={4} />
                                        </div>
                                    )}
                                    <span className={`block text-lg font-black ${duration === plan.val ? 'text-blue-700 dark:text-blue-400' : 'text-brand-muted dark:text-brand-muted'}`}>
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
                                    <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Frequência Semanal</label>
                                    <div className="relative">
                                        <select
                                            value={frequency}
                                            onChange={(e) => setFrequency(Number(e.target.value))}
                                            className="w-full px-4 py-3 bg-brand-surface-2 border-none rounded-xl font-bold text-brand-text dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}x na Semana</option>)}
                                        </select>
                                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                    </div>
                                </div>
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Vencimento</label>
                                    <div className="relative">
                                        <select
                                            value={dueDay}
                                            onChange={(e) => setDueDay(Number(e.target.value))}
                                            className="w-full px-4 py-3 bg-brand-surface-2 border-none rounded-xl font-bold text-brand-text dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                                                <option key={d} value={d}>Dia {d}</option>
                                            ))}
                                        </select>
                                        <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                    </div>
                                </div>
                            </div>

                            {/* Start Date & Pedagogical Level Control */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Início das Aulas</label>
                                    <div className="relative">
                                        <input
                                            type="date"
                                            value={startDate}
                                            min={dateInSaoPaulo()}
                                            onChange={(e) => setStartDate(e.target.value)}
                                            className="w-full px-4 py-3 bg-brand-surface-2 border-none rounded-xl font-bold text-brand-text dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                        <Clock className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 flex items-center gap-1.5">
                                        <BookOpen size={12} /> Nível Pedagógico
                                    </label>
                                    <div className="relative">
                                        <select
                                            value={studentLevel}
                                            onChange={(e) => setStudentLevel(e.target.value)}
                                            className="w-full px-4 py-3 bg-brand-surface-2 border-none rounded-xl font-bold text-brand-text dark:text-slate-200 appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            <option value="A1">A1 - Iniciante (A1-1)</option>
                                            <option value="A2">A2 - Elementar (A2-1)</option>
                                            <option value="B1">B1 - Intermediário (B1-1)</option>
                                            <option value="B2">B2 - Independente (B2-1)</option>
                                            <option value="C1">C1 - Avançado (C1-1)</option>
                                            <option value="C2">C2 - Proficiente (C2-1)</option>
                                        </select>
                                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                    </div>
                                </div>
                            </div>

                            {/* Manual Price Override */}
                            <div className="pt-2 border-t border-brand-border">
                                <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-brand-muted mb-2 cursor-pointer hover:text-blue-500 transition-colors">
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
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted font-bold text-sm">R$</span>
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
                            <div className="pt-4 border-t border-brand-border">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-brand-muted cursor-pointer hover:text-blue-500 transition-colors">
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
                                <p className="text-[9px] text-brand-muted font-medium">
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
                        <Calendar size={14} /> Início de Cobrança
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Mês de início da mensalidade</label>
                            <input
                                type="month"
                                value={billingStartMonth}
                                min={dateInSaoPaulo().slice(0, 7)}
                                onChange={(e) => setBillingStartMonth(e.target.value)}
                                className="w-full px-4 py-3 bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-700 rounded-xl font-bold text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-amber-500"
                            />
                            <p className="text-[9px] text-slate-400 mt-1">Escolha um mês futuro para diferir o início da cobrança recorrente.</p>
                        </div>
                        <div className="flex flex-col justify-center gap-2">
                            <div className={`flex items-start gap-3 ${duration === 0 ? 'opacity-60' : ''}`}>
                                <EnrollmentProRataSwitch
                                    checked={proRataEnabled}
                                    disabled={duration === 0}
                                    label="Cobrar pró-rata nesta matrícula"
                                    onCheckedChange={setEnableProRata}
                                />
                                <div>
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Cobrar pró-rata</p>
                                    <p className="text-[9px] text-slate-400">
                                        {duration === 0
                                            ? 'Não se aplica ao plano de aula avulsa.'
                                            : proRataEnabled
                                                ? `Ativado: as aulas anteriores à primeira mensalidade serão cobradas (mensalidade ÷ ${frequency * 4} aulas).`
                                                : 'Desativado: não haverá cobrança proporcional antes da primeira mensalidade.'}
                                    </p>
                                </div>
                            </div>
                            {proRataEnabled && monthlyFee > 0 && (
                                <div className="ml-13 pl-14 text-xs font-black text-amber-600 dark:text-amber-400">
                                    R$ {proRataPreview.pricePerClass.toFixed(2)}/aula × {proRataPreview.classCount} aulas
                                    {' = '}R$ {proRataPreview.value.toFixed(2)} até {proRataPreview.firstBillingDate.split('-').reverse().join('/')}
                                    <p className="mt-1 text-[9px] font-semibold text-amber-700/70 dark:text-amber-300/70">
                                        O banco recalcula e trava esse valor; a tela é apenas uma prévia.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* SECTION 2: ALOCAÇÃO ACADÊMICA */}
                <div className="bg-brand-surface-2/50 rounded-2xl p-6 border border-brand-border/50">
                    <div className="flex items-center gap-2 mb-6">
                        <div className="p-2 bg-brand-surface dark:bg-slate-700 rounded-lg shadow-sm">
                            <GraduationCap size={18} className="text-purple-600 dark:text-purple-400" />
                        </div>
                        <h3 className="text-sm font-black text-brand-text dark:text-slate-200 uppercase tracking-wide">
                            Alocação Acadêmica
                        </h3>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        {/* Professor Select (Searchable) */}
                        <div className="lg:col-span-1 relative z-50 flex flex-col gap-4">
                            <div>
                                <label className="text-[10px] font-bold uppercase text-brand-muted mb-2 block">Selecionar Professor</label>

                                <div className="relative group">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted group-focus-within:text-purple-500 transition-colors" size={16} />
                                    <input
                                        type="text"
                                        placeholder="Buscar Professor..."
                                        value={selectedProfessor ? (professors.find(p => p.id === selectedProfessor)?.name || '') : professorSearch}
                                        onChange={(e) => {
                                            setProfessorSearch(e.target.value);
                                            const previous = selectedProfessor;
                                            setSelectedProfessor(''); // Clear selection on type
                                            setScheduleSlots(current => current.map(slot => ({
                                                ...slot,
                                                teacherId: slot.teacherId === previous ? '' : slot.teacherId,
                                                time: slot.teacherId === previous ? '' : slot.time,
                                            })));
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
                                        className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-medium text-brand-text dark:text-slate-200 outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all shadow-sm cursor-pointer"
                                    />
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                </div>

                                {/* Dropdown List */}
                                {showProfessorList && (
                                    <>
                                        <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => setShowProfessorList(false)}
                                        />
                                        <div className="absolute top-full left-0 right-0 mt-2 bg-brand-surface border border-brand-border dark:border-brand-border rounded-xl shadow-xl max-h-60 overflow-y-auto z-50 animate-in fade-in zoom-in-95 duration-200">
                                            {professors.filter(p => !professorSearch || p.name.toLowerCase().includes(professorSearch.toLowerCase())).length > 0 ? (
                                                professors
                                                    .filter(p => !professorSearch || p.name.toLowerCase().includes(professorSearch.toLowerCase()))
                                                    .map(p => (
                                                        <button
                                                            key={p.id}
                                                            onClick={() => {
                                                                const previous = selectedProfessor;
                                                                setSelectedProfessor(p.id);
                                                                setScheduleSlots(current => current.map(slot => ({
                                                                    ...slot,
                                                                    teacherId: !slot.teacherId || slot.teacherId === previous ? p.id : slot.teacherId,
                                                                    time: !slot.teacherId || slot.teacherId === previous ? '' : slot.time,
                                                                })));
                                                                setShowProfessorList(false);
                                                                setProfessorSearch('');
                                                            }}
                                                            className="w-full text-left px-4 py-3 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 text-brand-text dark:text-slate-300 text-sm font-medium transition-colors flex items-center justify-between"
                                                        >
                                                            {p.name}
                                                            {selectedProfessor === p.id && <Check size={14} className="text-purple-500" />}
                                                        </button>
                                                    ))
                                            ) : (
                                                <div className="p-4 text-center text-brand-muted text-xs">
                                                    Nenhum professor encontrado.
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div>
                                <label className="text-[10px] font-bold uppercase text-brand-muted mb-2 block">Professor Secundário (Opcional)</label>

                                <div className="relative group">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted group-focus-within:text-purple-500 transition-colors" size={16} />
                                    <input
                                        type="text"
                                        placeholder="Buscar Professor 2..."
                                        value={selectedProfessor2 ? (professors.find(p => p.id === selectedProfessor2)?.name || '') : professorSearch2}
                                        onChange={(e) => {
                                            setProfessorSearch2(e.target.value);
                                            const previous = selectedProfessor2;
                                            setSelectedProfessor2('');
                                            setScheduleSlots(current => current.map(slot => ({
                                                ...slot,
                                                teacherId: slot.teacherId === previous ? selectedProfessor : slot.teacherId,
                                                time: slot.teacherId === previous ? '' : slot.time,
                                            })));
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
                                        className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-dashed border-brand-border dark:border-slate-600 rounded-xl text-sm font-medium text-brand-text dark:text-slate-200 outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all shadow-sm cursor-pointer"
                                    />
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                                </div>

                                {/* Dropdown List 2 */}
                                {showProfessorList2 && (
                                    <>
                                        <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => setShowProfessorList2(false)}
                                        />
                                        <div className="absolute top-full left-0 right-0 mt-2 bg-brand-surface border border-brand-border dark:border-brand-border rounded-xl shadow-xl max-h-60 overflow-y-auto z-50 animate-in fade-in zoom-in-95 duration-200">
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
                                                            className="w-full text-left px-4 py-3 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 text-brand-text dark:text-slate-300 text-sm font-medium transition-colors flex items-center justify-between"
                                                        >
                                                            {p.name}
                                                            {selectedProfessor2 === p.id && <Check size={14} className="text-purple-500" />}
                                                        </button>
                                                    ))
                                            ) : (
                                                <div className="p-4 text-center text-brand-muted text-xs">
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
                            <label className="text-[10px] font-bold uppercase text-brand-muted mb-2 block">
                                Grade Horária ({frequency}x na Semana)
                            </label>
                            {availabilityLoading && (
                                <p className="mb-2 flex items-center gap-2 text-[10px] font-bold text-purple-600">
                                    <Loader2 size={12} className="animate-spin" /> Confirmando a agenda publicada…
                                </p>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {scheduleSlots.map((slot, index) => (
                                    <div key={index} className="flex flex-wrap items-center gap-2 bg-brand-surface p-3 rounded-xl border border-brand-border shadow-sm group hover:border-purple-300 transition-colors">
                                        <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-bold text-xs shrink-0">
                                            {index + 1}
                                        </div>
                                        {selectedProfessor2 && (
                                            <select
                                                aria-label={`Professor do horário ${index + 1}`}
                                                value={slot.teacherId || selectedProfessor}
                                                onChange={event => updateSlot(index, 'teacherId', event.target.value)}
                                                className="min-w-36 flex-1 bg-transparent text-xs font-semibold text-brand-text dark:text-slate-200 outline-none"
                                            >
                                                <option value={selectedProfessor}>{professors.find(p => p.id === selectedProfessor)?.name || 'Professor principal'}</option>
                                                <option value={selectedProfessor2}>{professors.find(p => p.id === selectedProfessor2)?.name || 'Professor secundário'}</option>
                                            </select>
                                        )}
                                        <select
                                            aria-label={`Dia do horário ${index + 1}`}
                                            value={slot.day}
                                            onChange={e => updateSlot(index, 'day', e.target.value)}
                                            className="w-28 bg-transparent text-xs font-semibold text-brand-text dark:text-slate-200 outline-none"
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
                                        <select
                                            aria-label={`Hora do horário ${index + 1}`}
                                            value={slot.time}
                                            onChange={e => updateSlot(index, 'time', e.target.value)}
                                            disabled={!slot.day || availabilityLoading}
                                            className="min-w-24 flex-1 bg-transparent text-xs font-mono font-medium text-brand-text dark:text-slate-200 outline-none disabled:opacity-50"
                                        >
                                            <option value="">Horário livre</option>
                                            {availableTimes(slot.teacherId || selectedProfessor, slot.day).map(time => (
                                                <option key={time} value={time}>{time}</option>
                                            ))}
                                        </select>
                                        {slot.day && !availabilityLoading && availableTimes(slot.teacherId || selectedProfessor, slot.day).length === 0 && (
                                            <p className="basis-full pl-10 text-[9px] font-bold text-red-600">
                                                Sem horário livre publicado neste dia.
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* SECTION 2.5: MATRÍCULA DE DEPENDENTE (cobrança no CPF de outro titular) */}
                <div className="bg-indigo-50/60 dark:bg-indigo-900/10 rounded-2xl p-6 border border-indigo-200/70 dark:border-indigo-900/30">
                    <label className="flex items-center gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isDependent}
                            onChange={e => { setIsDependent(e.target.checked); if (!e.target.checked) { setSelectedGuardianId(''); setGuardianSearch(''); } }}
                            className="w-5 h-5 rounded accent-indigo-600 shrink-0"
                        />
                        <span className="text-sm font-black text-brand-text dark:text-slate-200">
                            🔗 Cobrança no CPF de outro titular (responsável financeiro)
                        </span>
                    </label>

                    {isDependent && (
                        <div className="mt-4 space-y-2 relative z-40">
                            <p className="text-[11px] text-brand-muted leading-relaxed">
                                O aluno preenche o link com o <strong>próprio nome e e-mail</strong>, mas a assinatura é cobrada no
                                CPF do responsável escolhido abaixo. Gera assinatura distinta no mesmo CPF — qualquer relação
                                (cônjuge, familiar, terceiro pagador).
                            </p>
                            <div>
                                <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">WhatsApp do aluno (confirmação de aula)</label>
                                <input
                                    type="text"
                                    value={studentPhone}
                                    onChange={e => setStudentPhone(e.target.value)}
                                    placeholder="DDD + número de quem assiste a aula"
                                    className="w-full px-4 py-3 bg-brand-surface border border-indigo-300 dark:border-indigo-900/50 rounded-xl text-sm font-medium text-brand-text dark:text-slate-200 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all shadow-sm font-mono"
                                />
                                <p className="text-[10px] text-brand-muted mt-1">A confirmação de presença vai para este número (o aluno que assiste). A cobrança continua no responsável.</p>
                            </div>
                            <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Responsável financeiro (titular já cadastrado)</label>
                            <div className="relative group">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted group-focus-within:text-indigo-500 transition-colors" size={16} />
                                <input
                                    type="text"
                                    placeholder="Buscar por nome ou CPF..."
                                    value={selectedGuardian ? `${selectedGuardian.full_name} — CPF ${selectedGuardian.cpf}` : guardianSearch}
                                    onChange={e => { setGuardianSearch(e.target.value); setSelectedGuardianId(''); setShowGuardianList(true); }}
                                    onFocus={() => { setGuardianSearch(''); setShowGuardianList(true); }}
                                    onClick={() => { setGuardianSearch(''); setShowGuardianList(true); }}
                                    className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-indigo-300 dark:border-indigo-900/50 rounded-xl text-sm font-medium text-brand-text dark:text-slate-200 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all shadow-sm cursor-pointer"
                                />
                                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />
                            </div>
                            {showGuardianList && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setShowGuardianList(false)} />
                                    <div className="absolute left-0 right-0 mt-2 bg-brand-surface border border-brand-border rounded-xl shadow-xl max-h-60 overflow-y-auto z-50 animate-in fade-in zoom-in-95 duration-200">
                                        {(() => {
                                            const q = guardianSearch.trim().toLowerCase();
                                            const list = guardianCandidates.filter(g =>
                                                !q ||
                                                (g.full_name || '').toLowerCase().includes(q) ||
                                                (g.cpf || '').replace(/\D/g, '').includes(q.replace(/\D/g, ''))
                                            ).slice(0, 30);
                                            return list.length > 0 ? list.map(g => (
                                                <button
                                                    key={g.id}
                                                    onClick={() => { setSelectedGuardianId(g.id); setShowGuardianList(false); setGuardianSearch(''); }}
                                                    className="w-full text-left px-4 py-3 hover:bg-brand-surface-2 transition-colors flex items-center justify-between"
                                                >
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-bold text-brand-text dark:text-slate-200 truncate">{g.full_name}</span>
                                                        <span className="block text-[11px] text-brand-muted font-mono">CPF {g.cpf}{g.email ? ` · ${g.email}` : ''}</span>
                                                    </span>
                                                    {selectedGuardianId === g.id && <Check size={14} className="text-indigo-500 shrink-0" />}
                                                </button>
                                            )) : <div className="p-4 text-center text-brand-muted text-xs">Nenhum titular cadastrado encontrado.</div>;
                                        })()}
                                    </div>
                                </>
                            )}
                            {selectedGuardian && (
                                <p className="text-[11px] text-emerald-600 font-bold flex items-center gap-1"><Check size={12} /> Cobrança será feita no CPF de {selectedGuardian.full_name}.</p>
                            )}
                        </div>
                    )}
                </div>

                {/* SECTION 3: MAGIC LINK AREA */}
                <div className={`transition-all duration-500 ${generatedLink ? 'opacity-100 translate-y-0' : ''}`}>
                    {formError && (
                        <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
                            <AlertCircle size={18} className="mt-0.5 shrink-0" />
                            <span>{formError}</span>
                        </div>
                    )}
                    <button
                        onClick={generateLink}
                        disabled={!isFormValid}
                        className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-blue-500/20 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 group"
                    >
                        {generating
                            ? <Loader2 size={18} className="animate-spin" />
                            : <Sparkles size={18} className="group-hover:animate-spin-slow" />}
                        {generating ? 'Validando grade e contrato…' : 'Gerar Link Seguro'}
                    </button>

                    {generatedLink && (
                        <div className="mt-6 animate-in fade-in slide-in-from-top-4">
                            <div className="bg-brand-surface rounded-2xl p-4 flex items-center gap-4 border border-brand-border shadow-2xl">
                                <LinkIcon size={20} className="text-emerald-400 shrink-0" />
                                <div className="flex-1 overflow-hidden">
                                    <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider mb-1">
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
                                        : 'bg-brand-surface-2 text-slate-300 hover:bg-slate-700'
                                        }`}
                                >
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                    {copied ? 'Copiado!' : 'Copiar'}
                                </button>
                            </div>
                            <p className="text-center text-[10px] text-brand-muted mt-3 font-medium">
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
