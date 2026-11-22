
import React, { useEffect, useMemo, useState } from 'react';
import TeacherTrainingScheduler from './TeacherTrainingScheduler';
import { X, Clock, User, Phone, Send, Zap, Calendar, Plus, Minus, Users, UserCheck, Link2, Search, CheckCircle2, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { buildBroadcastErrorMessage, parseFunctionErrorAsync } from '../lib/functionInvokeErrors';
import { formatDatePtBr, formatTime24, todayLocalIso } from '../lib/ptBrDateTime';

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

// Mesma lista do servidor (broadcast-opportunity): status que nunca recebe convite.
const INACTIVE_STATUS = ['Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado'];

interface PreferredSlot {
    weekday: string;
    time: string;
}

type DispatchMode = 'individual' | 'teacher' | 'link_only';

interface TeacherOption {
    id: string;
    name: string;
}

type Feedback = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

// Campo de data/hora que MOSTRA sempre pt-BR e 24 h. O input nativo fica por cima, invisível,
// só para abrir o seletor do aparelho — no iPhone ele seguia o idioma do sistema ("24 Nov 2026",
// "12:30 PM") e vazava pela borda direita.
const NativePickerField: React.FC<{
    type: 'date' | 'time';
    value: string;
    onChange: (v: string) => void;
    label: string;
    icon: React.ReactNode;
    className: string;
    textClassName: string;
}> = ({ type, value, onChange, label, icon, className, textClassName }) => {
    const shown = type === 'date' ? formatDatePtBr(value) : formatTime24(value);
    return (
        <label className={`relative flex min-h-[52px] min-w-0 items-center gap-3 overflow-hidden ${className}`}>
            <span className="shrink-0">{icon}</span>
            <span className={`min-w-0 flex-1 truncate ${textClassName}`}>{shown || (type === 'date' ? 'Escolher data' : 'Escolher hora')}</span>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                // No desktop o clique no campo só focava o input invisível; showPicker abre o seletor.
                onClick={(e) => {
                    try {
                        (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
                    } catch {
                        // Navegador sem showPicker: o seletor abre pelo próprio input.
                    }
                }}
                aria-label={label}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
        </label>
    );
};

const SmartFinder: React.FC<{ user?: any }> = ({ user }) => {
    const [isOpen, setIsOpen] = useState(false);

    // Form State
    const [studentName, setStudentName] = useState('');
    const [studentPhone, setStudentPhone] = useState('');
    const [studentInterests, setStudentInterests] = useState('');

    // Data local (o toISOString virava o dia seguinte depois das 21h em Brasília).
    const [targetDate, setTargetDate] = useState<string>(todayLocalIso());
    const [targetTime, setTargetTime] = useState<string>('19:00');

    // Preferred Slots (weekly preferences)
    const [preferredSlots, setPreferredSlots] = useState<PreferredSlot[]>([]);

    // TRIAL = aula experimental de aluno · TRAINING = treinamento de professor.
    // Sem este campo o broadcast caía sempre em TRIAL, e o treinamento entrava na
    // folha como AULA EXPERIMENTAL a R$ 8,00 em vez de R$ 16,00 de treinador —
    // foi o que aconteceu com o treinamento da Teacher Lais em julho/2026.
    const [kind, setKind] = useState<'TRIAL' | 'TRAINING'>('TRIAL');

    // Como disparar: todos os ativos (convites privados), um professor escolhido, ou só o link.
    const [dispatchMode, setDispatchMode] = useState<DispatchMode>('individual');
    const [teachers, setTeachers] = useState<TeacherOption[] | null>(null);
    const [teachersError, setTeachersError] = useState('');
    const [teacherSearch, setTeacherSearch] = useState('');
    const [targetTeacherId, setTargetTeacherId] = useState('');

    const [lastClaimLink, setLastClaimLink] = useState('');
    const [linkCopied, setLinkCopied] = useState(false);
    const [feedback, setFeedback] = useState<Feedback>(null);

    const [loading, setLoading] = useState(false);

    const tenantId = user?.tenantId || user?.tenant_id || '';

    useEffect(() => {
        if (!isOpen || dispatchMode !== 'teacher' || teachers !== null) return;
        let cancelled = false;
        (async () => {
            let query = supabase
                .from('profiles')
                .select('id, full_name, status')
                .eq('role', 'TEACHER')
                .eq('lifecycle_status', 'active')
                .not('phone', 'is', null)
                .order('full_name', { ascending: true });
            if (tenantId) query = query.eq('tenant_id', tenantId);
            const { data, error } = await query;
            if (cancelled) return;
            if (error) {
                setTeachersError('Não foi possível carregar os professores. Feche e abra o Lançador.');
                setTeachers([]);
                return;
            }
            setTeachers((data || [])
                .filter((t: any) => !INACTIVE_STATUS.includes(t.status || ''))
                .map((t: any) => ({ id: t.id, name: t.full_name || 'Professor sem nome' })));
        })();
        return () => { cancelled = true; };
    }, [isOpen, dispatchMode, teachers, tenantId]);

    const filteredTeachers = useMemo(() => {
        const needle = teacherSearch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const list = teachers || [];
        if (!needle) return list;
        return list.filter(t => t.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(needle));
    }, [teachers, teacherSearch]);

    const selectedTeacher = (teachers || []).find(t => t.id === targetTeacherId) || null;

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
        setFeedback(null);
        if (!studentName || !studentPhone || !targetTime || !targetDate) {
            setFeedback({ tone: 'error', text: 'Preencha nome, WhatsApp, data e horário.' });
            return;
        }

        // O broadcast-opportunity valida tudo de uma vez e responde só
        // "Invalid opportunity payload", sem dizer qual campo reprovou. Estas
        // checagens espelham as regras do servidor para apontar o campo aqui.
        const phoneDigits = studentPhone.replace(/\D/g, '');
        if (kind === 'TRIAL' && phoneDigits.length < 10) {
            setFeedback({ tone: 'error', text: 'WhatsApp incompleto: informe DDD + número (ao menos 10 dígitos).' });
            return;
        }
        const badSlot = preferredSlots.findIndex(
            (slot) => !WEEKDAYS.some((day) => day.value === slot.weekday)
                || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time),
        );
        if (badSlot >= 0) {
            setFeedback({ tone: 'error', text: `Preferência de horário ${badSlot + 1} está incompleta. Preencha o dia e a hora, ou remova a linha.` });
            return;
        }
        if (dispatchMode === 'teacher' && !targetTeacherId) {
            setFeedback({ tone: 'error', text: 'Escolha o professor que vai receber o convite.' });
            return;
        }

        setLoading(true);
        try {
            const { data: { session }, error: sessionError } = await supabase.auth.getSession();

            if (sessionError || !session) {
                console.error("Session Error:", sessionError);
                setFeedback({ tone: 'error', text: 'Sua sessão expirou. Entre de novo para disparar.' });
                setLoading(false);
                return;
            }

            const { data, error } = await supabase.functions.invoke('broadcast-opportunity', {
                body: {
                    student_name: studentName,
                    student_phone: studentPhone,
                    date: targetDate,
                    time: formatTime24(targetTime) || targetTime,
                    interests: studentInterests,
                    preferred_slots: preferredSlots.length > 0 ? preferredSlots : undefined,
                    dispatch_mode: dispatchMode,
                    ...(dispatchMode === 'teacher' ? { target_teacher_id: targetTeacherId } : {}),
                    kind,
                },
            });

            if (error || data?.error) {
                const parsedError = await parseFunctionErrorAsync({
                    error,
                    data,
                    fallbackMessage: 'Falha ao divulgar oportunidade.',
                });
                if (parsedError.code === 'target_teacher_not_eligible' || data?.error_code === 'target_teacher_not_eligible') {
                    throw new Error('Este professor não pode receber convites agora (suspenso, desligado ou sem WhatsApp). Escolha outro.');
                }
                const friendlyMessage = buildBroadcastErrorMessage(parsedError);
                throw new Error(friendlyMessage + (parsedError.details ? `\n\n${parsedError.details}` : ''));
            }

            if (data?.claim_link) {
                setLastClaimLink(String(data.claim_link));
                setLinkCopied(false);
            }

            if (dispatchMode === 'link_only') {
                setFeedback({ tone: 'ok', text: 'Experimental criada. Nada foi enviado: copie o link abaixo e mande ao professor. O primeiro professor ativo que aceitar leva a aula.' });
            } else if (data?.warning) {
                setFeedback({ tone: 'warn', text: `Vaga criada, mas houve falha no WhatsApp. Professores notificados: ${data.recipients ?? 0} de ${data.total_active_teachers ?? 0}. ${data.warning}` });
            } else if (dispatchMode === 'teacher') {
                setFeedback({ tone: 'ok', text: `Convite enviado em privado para ${selectedTeacher?.name || 'o professor escolhido'}.` });
            } else {
                setFeedback({ tone: 'ok', text: `Oportunidade enviada. Professores notificados: ${data.recipients ?? 0} de ${data.total_active_teachers ?? 0}.` });
            }

            setStudentName('');
            setStudentPhone('');
            setStudentInterests('');
            setPreferredSlots([]);

        } catch (err: any) {
            setFeedback({ tone: 'error', text: `Erro ao disparar: ${err.message}` });
        } finally {
            setLoading(false);
        }
    };

    const close = () => {
        setIsOpen(false);
        setFeedback(null);
        // Se a lista falhou, reabrir tenta de novo.
        if (teachersError) {
            setTeachers(null);
            setTeachersError('');
        }
    };

    const dispatchOptions: { id: DispatchMode; title: string; hint: string; icon: React.ReactNode }[] = [
        { id: 'individual', title: 'Todos os professores ativos', hint: 'Convite privado para cada um.', icon: <Users size={18} /> },
        { id: 'teacher', title: 'Escolher professor', hint: 'Só o professor escolhido recebe.', icon: <UserCheck size={18} /> },
        { id: 'link_only', title: 'Só gerar o link', hint: 'Não manda nada; você copia e envia.', icon: <Link2 size={18} /> },
    ];

    const actionLabel = dispatchMode === 'link_only' ? 'GERAR LINK' : 'DISPARAR AGORA';

    return (
        <>
            {/* Floating Trigger Button */}
            <button
                data-tour="smart-finder-launch"
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 right-6 z-50 bg-linear-to-r from-orange-500 to-red-600 text-white p-3 rounded-full shadow-lg hover:scale-110 active:scale-95 transition-all flex items-center justify-center group"
                title="Lançar Vaga"
            >
                <Zap size={28} fill="currentColor" className="group-hover:animate-pulse" />
            </button>

            {/* Modal Drawer: acima da barra de navegação de baixo (z-[70]) e em tela cheia no celular */}
            {isOpen && (
                <div className="fixed inset-0 z-[70] flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in">
                    <div className="flex h-full w-full max-w-md flex-col overflow-x-hidden overflow-y-auto bg-brand-surface px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl animate-in slide-in-from-right duration-300 sm:px-6">

                        {/* Header */}
                        <div className="mb-6 flex items-center justify-between">
                            <h2 className="text-2xl font-black text-brand-text flex items-center gap-2 uppercase tracking-tight">
                                <Zap className="text-orange-500" size={28} />
                                Lançador
                            </h2>
                            <button onClick={close} aria-label="Fechar" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-brand-surface-2 transition-colors">
                                <X size={24} className="text-brand-muted" />
                            </button>
                        </div>

                        <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl border-2 border-brand-border bg-brand-surface-2 p-1">
                            <button
                                type="button"
                                onClick={() => setKind('TRIAL')}
                                className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-2 text-xs font-bold transition-colors ${kind === 'TRIAL'
                                    ? 'bg-indigo-600 text-white shadow-sm'
                                    : 'text-brand-muted hover:bg-brand-surface'
                                    }`}
                            >
                                Aula experimental
                            </button>
                            <button
                                type="button"
                                onClick={() => setKind('TRAINING')}
                                className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-2 text-center text-xs font-bold leading-tight transition-colors ${kind === 'TRAINING'
                                    ? 'bg-indigo-600 text-white shadow-sm'
                                    : 'text-brand-muted hover:bg-brand-surface'
                                    }`}
                            >
                                Treinamento de professor
                            </button>
                        </div>

                        {kind === 'TRAINING' ? <TeacherTrainingScheduler tenantId={tenantId} /> : <>
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
                                    className="w-full px-4 py-3 bg-brand-surface-2 border-2 border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                />
                                <div className="relative">
                                    <input
                                        value={studentPhone}
                                        onChange={(e) => setStudentPhone(e.target.value)}
                                        inputMode="tel"
                                        placeholder="WhatsApp (Ex: 5511999999999)"
                                        className="w-full pl-10 pr-4 py-3 bg-brand-surface-2 border-2 border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                    />
                                    <Phone className="absolute left-3 top-3.5 text-brand-muted" size={18} />
                                </div>
                                <textarea
                                    value={studentInterests}
                                    onChange={(e) => setStudentInterests(e.target.value)}
                                    placeholder="Interesse / Objetivo (Ex: Inglês para viagem, Reforço escolar...)"
                                    className="w-full px-4 py-3 bg-brand-surface-2 border-2 border-brand-border rounded-xl font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors resize-none h-24"
                                />
                            </div>

                            {/* Date & Time Slot */}
                            <div className="space-y-4">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2">
                                    <Clock size={14} /> Data e Horário da Experimental
                                </p>

                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <NativePickerField
                                        type="date"
                                        value={targetDate}
                                        onChange={setTargetDate}
                                        label="Data da experimental"
                                        icon={<Calendar className="text-brand-muted" size={20} />}
                                        className="rounded-2xl border-2 border-brand-border bg-brand-surface-2 px-4 focus-within:border-orange-500"
                                        textClassName="font-bold text-brand-text"
                                    />
                                    <NativePickerField
                                        type="time"
                                        value={targetTime}
                                        onChange={setTargetTime}
                                        label="Horário da experimental"
                                        icon={<Clock className="text-orange-400" size={20} />}
                                        className="rounded-2xl border-2 border-orange-100 bg-orange-50 px-4 focus-within:border-orange-500 dark:border-orange-800/30 dark:bg-orange-900/10"
                                        textClassName="text-xl font-black tabular-nums text-orange-600 dark:text-orange-400"
                                    />
                                </div>
                            </div>

                            {/* PREFERRED WEEKLY SLOTS */}
                            <div className="space-y-3">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="flex items-center gap-2"><Calendar size={14} /> Preferência de horários na semana</span>
                                    <span className="text-[10px] font-normal normal-case tracking-normal text-brand-muted">(opcional)</span>
                                </p>

                                {preferredSlots.map((slot, idx) => (
                                    <div key={idx} className="flex min-w-0 items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
                                        <select
                                            value={slot.weekday}
                                            onChange={(e) => updateSlot(idx, 'weekday', e.target.value)}
                                            className="min-h-[44px] min-w-0 flex-1 px-3 bg-brand-surface-2 border-2 border-brand-border rounded-xl text-sm font-medium text-brand-text focus:border-orange-500 focus:ring-0 transition-colors"
                                        >
                                            {WEEKDAYS.map(day => (
                                                <option key={day.value} value={day.value}>{day.label}</option>
                                            ))}
                                        </select>

                                        <NativePickerField
                                            type="time"
                                            value={slot.time}
                                            onChange={(v) => updateSlot(idx, 'time', v)}
                                            label={`Horário da preferência ${idx + 1}`}
                                            icon={<Clock className="text-orange-400" size={16} />}
                                            className="w-28 shrink-0 rounded-xl border-2 border-orange-100 bg-orange-50 px-3 dark:border-orange-800/30 dark:bg-orange-900/10"
                                            textClassName="text-sm font-bold tabular-nums text-orange-600 dark:text-orange-400"
                                        />

                                        <button
                                            onClick={() => removeSlot(idx)}
                                            aria-label={`Remover preferência ${idx + 1}`}
                                            className="flex h-11 w-11 shrink-0 items-center justify-center text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                        >
                                            <Minus size={16} />
                                        </button>
                                    </div>
                                ))}

                                {preferredSlots.length < 10 && (
                                    <button
                                        onClick={addSlot}
                                        className="flex min-h-[44px] items-center gap-2 text-xs font-bold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-3 rounded-lg transition-colors w-full justify-center border-2 border-dashed border-indigo-200 hover:border-indigo-300"
                                    >
                                        <Plus size={14} />
                                        Adicionar horário
                                    </button>
                                )}
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-wider flex items-center gap-2 pt-2">
                                    <Send size={14} /> Como disparar
                                </p>
                                <div role="radiogroup" aria-label="Como disparar" className="space-y-2">
                                    {dispatchOptions.map(option => {
                                        const selected = dispatchMode === option.id;
                                        return (
                                            <button
                                                key={option.id}
                                                type="button"
                                                role="radio"
                                                aria-checked={selected}
                                                onClick={() => { setDispatchMode(option.id); setFeedback(null); }}
                                                className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition-colors ${selected
                                                    ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/10'
                                                    : 'border-brand-border bg-brand-surface-2'}`}
                                            >
                                                <span className={selected ? 'text-orange-600' : 'text-brand-muted'}>{option.icon}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm font-bold text-brand-text">{option.title}</span>
                                                    <span className="block text-[11px] text-brand-muted">{option.hint}</span>
                                                </span>
                                                <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${selected ? 'border-orange-500 bg-orange-500' : 'border-brand-border'}`} />
                                            </button>
                                        );
                                    })}
                                </div>

                                {dispatchMode === 'teacher' && (
                                    <div className="space-y-2 rounded-xl border-2 border-brand-border p-3">
                                        <div className="relative">
                                            <Search className="absolute left-3 top-3 text-brand-muted" size={16} />
                                            <input
                                                value={teacherSearch}
                                                onChange={(e) => setTeacherSearch(e.target.value)}
                                                placeholder="Buscar professor pelo nome"
                                                className="min-h-[44px] w-full rounded-lg border-2 border-brand-border bg-brand-surface-2 pl-9 pr-3 text-sm text-brand-text focus:border-orange-500 focus:ring-0"
                                            />
                                        </div>
                                        {teachers === null && <p className="text-xs text-brand-muted">Carregando professores…</p>}
                                        {teachersError && <p className="text-xs font-bold text-red-600">{teachersError}</p>}
                                        {teachers !== null && !teachersError && filteredTeachers.length === 0 && (
                                            <p className="text-xs text-brand-muted">Nenhum professor ativo encontrado.</p>
                                        )}
                                        <ul className="max-h-56 space-y-1 overflow-y-auto">
                                            {filteredTeachers.map(t => (
                                                <li key={t.id}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setTargetTeacherId(t.id)}
                                                        className={`flex min-h-[44px] w-full items-center justify-between rounded-lg px-3 text-left text-sm ${targetTeacherId === t.id ? 'bg-orange-500 font-bold text-white' : 'text-brand-text hover:bg-brand-surface-2'}`}
                                                    >
                                                        <span className="truncate">{t.name}</span>
                                                        {targetTeacherId === t.id && <CheckCircle2 size={16} />}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                <p className="text-[11px] text-brand-muted font-medium px-1">
                                    {dispatchMode === 'link_only'
                                        ? 'Ninguém recebe mensagem. Quem abrir o link precisa ser professor ativo e estar logado; o primeiro que aceitar leva a aula.'
                                        : 'A situação do professor é conferida antes de cada convite. Suspensos e desligados não recebem oportunidades.'}
                                </p>
                            </div>

                        </div>

                        {feedback && (
                            <div
                                role="status"
                                className={`mt-6 flex items-start gap-2 rounded-xl p-3 text-sm font-bold ${feedback.tone === 'ok'
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : feedback.tone === 'warn'
                                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                        : 'bg-red-500/10 text-red-700 dark:text-red-300'}`}
                            >
                                {feedback.tone === 'ok' ? <CheckCircle2 size={18} className="shrink-0" /> : <AlertTriangle size={18} className="shrink-0" />}
                                <span className="whitespace-pre-line">{feedback.text}</span>
                            </div>
                        )}

                        {lastClaimLink && (
                            <div className="mt-4 p-4 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 dark:bg-emerald-900/10">
                                <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Link da experimental</p>
                                <p className="text-[11px] text-brand-muted mt-1 break-all">{lastClaimLink}</p>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        try {
                                            await navigator.clipboard.writeText(lastClaimLink);
                                            setLinkCopied(true);
                                            setTimeout(() => setLinkCopied(false), 2500);
                                        } catch {
                                            setLinkCopied(false);
                                        }
                                    }}
                                    className="mt-3 min-h-[44px] w-full rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
                                >
                                    {linkCopied ? 'Link copiado!' : 'Copiar'}
                                </button>
                            </div>
                        )}

                        {/* Action Button */}
                        <div className="mt-8 border-t border-brand-border pt-6">
                            <button
                                onClick={handleBroadcast}
                                disabled={loading}
                                className="w-full bg-linear-to-r from-orange-500 to-red-600 text-white py-5 rounded-2xl font-black text-lg shadow-xl shadow-orange-200 dark:shadow-none hover:shadow-2xl active:scale-95 transition-all flex justify-center items-center gap-3 disabled:opacity-70 disabled:grayscale"
                            >
                                {loading ? (
                                    <div className="animate-spin rounded-full h-6 w-6 border-4 border-white border-t-transparent" />
                                ) : (
                                    <>
                                        {dispatchMode === 'link_only' ? <Link2 size={24} /> : <Send size={24} fill="white" />}
                                        {actionLabel}
                                    </>
                                )}
                            </button>
                            <p className="text-center text-[11px] text-brand-muted mt-3 font-medium">
                                {dispatchMode === 'individual' && 'Envia individualmente a cada professor ativo da escola.'}
                                {dispatchMode === 'teacher' && (selectedTeacher ? `Envia só para ${selectedTeacher.name}.` : 'Escolha o professor acima.')}
                                {dispatchMode === 'link_only' && 'Cria a experimental e mostra o link para copiar.'}
                            </p>
                        </div>

                        </>}
                    </div>
                </div>
            )}
        </>
    );
};

export default SmartFinder;
