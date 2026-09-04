import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    Zap, Users, ArrowRight, Check, X, Star, BookOpen, DollarSign,
    UserPlus, Award, TrendingUp, AlertCircle, Loader2, Phone,
    Mail, ChevronRight, Calendar, ThermometerSun, FileText, XCircle,
    Link as LinkIcon, Copy, Sparkles, Wallet, ChevronDown, Search, Clock, RefreshCw
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { buildBroadcastErrorMessage, parseFunctionError } from '../lib/functionInvokeErrors';
import { APP_BASE_URL } from '../constants';
import { pricingService, PricingMatrix } from '../services/pricingService';
import { normalizeEnrollmentProRataTerms } from '../lib/enrollment';
import EnrollmentProRataSwitch from './EnrollmentProRataSwitch';
import {
    calculateEnrollmentProRataPreview,
    dateInSaoPaulo,
    defaultBillingStartMonthInSaoPaulo,
    enrollmentOfferErrorMessage,
    normalizeEnrollmentTime,
    weekdayIndex,
} from '../lib/enrollmentOffer';

const WEEKDAY_OPTIONS = [
    { value: 'monday', label: 'Segunda' },
    { value: 'tuesday', label: 'Terça' },
    { value: 'wednesday', label: 'Quarta' },
    { value: 'thursday', label: 'Quinta' },
    { value: 'friday', label: 'Sexta' },
    { value: 'saturday', label: 'Sábado' },
];

interface ScheduleSlot {
    weekday: string;
    time: string;
}

// =============================================================
// TYPES
// =============================================================
interface Opportunity {
    id: string;
    student_name: string;
    student_phone: string;
    tenant_id: string;
    status: string;
    trial_status: string;
    conversion_status: string;
    winner_teacher_id: string;
    professor_id?: string | null;
    trial_appointment_id: string;
    student_id: string | null;
    lost_reason: string | null;
    created_at: string;
    slots_proposed: any;
    accepted_slot: any;
    feedback_required?: boolean | null;
}

interface Feedback {
    id: string;
    tenant_id: string;
    opportunity_id: string;
    booking_id: string;
    recommended_level: string;
    recommended_plan: string;
    interest_score: number;
    notes: string;
    teacher_id: string;
}

interface Teacher {
    id: string;
    full_name: string;
}

interface EnrollmentLink {
    id: string;
    tenant_id: string;
    opportunity_id: string;
    link_url: string;
    status: string;
    created_at: string;
    expires_at: string;
    offer_id: string;
    offer?: EnrollmentOfferRelation | EnrollmentOfferRelation[] | null;
}

interface EnrollmentOfferRelation {
    id: string;
    kind: string;
    tenant_id: string;
    opportunity_id: string | null;
    expires_at: string;
    revoked_at: string | null;
    consumed_at: string | null;
}

interface TrialsToContractsProps {
    tenantId?: string;
    user: any;
}

// Pricing matrix now loaded from DB (student_pricing_plans) via pricingService.
// Hardcoded values live in services/pricingService.ts as fallback.

// Map trial_feedback recommended_plan to frequency
const planToFrequency = (plan: string): number => {
    if (!plan) return 2;
    const lower = plan.toLowerCase();
    if (lower.includes('1x')) return 2; // minimum 2x
    if (lower.includes('2x')) return 2;
    if (lower.includes('3x')) return 3;
    if (lower.includes('4x')) return 4;
    if (lower.includes('5x') || lower.includes('intensivo')) return 5;
    return 2;
};

const relationOne = <T,>(value: T | T[] | null | undefined): T | null =>
    Array.isArray(value) ? value[0] ?? null : value ?? null;

const isFutureInstant = (value: string | null | undefined, nowMs: number): boolean => {
    if (!value) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > nowMs;
};

const isUsableEnrollmentLink = (link: EnrollmentLink, opportunity: Opportunity, nowMs: number): boolean => {
    const offer = relationOne(link.offer);
    return link.status === 'PENDING'
        && link.offer_id === offer?.id
        && link.opportunity_id === opportunity.id
        && link.tenant_id === opportunity.tenant_id
        && isFutureInstant(link.expires_at, nowMs)
        && offer?.kind === 'ENROLLMENT'
        && offer.tenant_id === opportunity.tenant_id
        && offer.opportunity_id === opportunity.id
        && offer.revoked_at === null
        && offer.consumed_at === null
        && isFutureInstant(offer.expires_at, nowMs);
};

const isCompleteTrialFeedback = (opportunity: Opportunity, feedback: Feedback | undefined): boolean => {
    const teacherId = opportunity.winner_teacher_id || opportunity.professor_id;
    return Boolean(
        feedback
        && teacherId
        && opportunity.trial_appointment_id
        && feedback.tenant_id === opportunity.tenant_id
        && feedback.booking_id === opportunity.trial_appointment_id
        && feedback.teacher_id === teacherId
    );
};

const enrollmentCreationErrorMessage = (error: unknown): string => {
    const raw = error instanceof Error
        ? `${error.name} ${error.message}`
        : typeof error === 'object' && error !== null
            ? JSON.stringify(error)
            : String(error || '');
    const normalized = raw.toLowerCase();
    if (normalized.includes('trial_feedback_required')) {
        return 'O feedback da aula experimental é obrigatório antes de gerar a matrícula. Peça ao professor para concluir a avaliação e tente novamente.';
    }
    if (normalized.includes('enrollment_in_progress')) {
        return 'Já existe uma matrícula em andamento para esta oportunidade. Aguarde a conclusão ou revise o link atual antes de gerar outro.';
    }
    return enrollmentOfferErrorMessage(error);
};

// Converte um slot da oportunidade (preferred_slots) para o weekday em inglês minúsculo
// que o wizard usa. O SDR grava { dow: int, time }; formatos legados podem trazer
// { weekday: 'monday' | 'Segunda' } ou { day: int }.
const DOW_TO_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PT_TO_EN: Record<string, string> = {
    'segunda': 'monday', 'terca': 'tuesday', 'terça': 'tuesday', 'quarta': 'wednesday',
    'quinta': 'thursday', 'sexta': 'friday', 'sabado': 'saturday', 'sábado': 'saturday', 'domingo': 'sunday',
};
const slotToEnWeekday = (s: any): string | null => {
    if (s == null) return null;
    if (typeof s.dow === 'number') return DOW_TO_EN[s.dow] ?? null;
    if (typeof s.day === 'number') return DOW_TO_EN[s.day] ?? null;
    const w = String(s.weekday ?? s.day ?? '').trim().toLowerCase();
    if (!w) return null;
    if (DOW_TO_EN.includes(w)) return w;
    if (w in PT_TO_EN) return PT_TO_EN[w];
    if (/^[0-6]$/.test(w)) return DOW_TO_EN[Number(w)] ?? null;
    return null;
};

// =============================================================
// MAIN COMPONENT
// =============================================================
const TrialsToContracts: React.FC<TrialsToContractsProps> = ({ tenantId, user }) => {
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [feedbacks, setFeedbacks] = useState<Record<string, Feedback>>({});
    const [teachers, setTeachers] = useState<Teacher[]>([]);
    const [enrollmentLinks, setEnrollmentLinks] = useState<Record<string, EnrollmentLink>>({});
    const [appointments, setAppointments] = useState<Record<string, { start_time: string }>>({});
    const outcomeRequestIds = useRef<Record<string, string>>({});
    const enrollmentOfferRequestIds = useRef<Record<string, string>>({});

    // Wizard State (Enrollment Link Modal)
    const [wizardOpp, setWizardOpp] = useState<Opportunity | null>(null);
    const [wizardSaving, setWizardSaving] = useState(false);

    // Wizard Form Data
    const [duration, setDuration] = useState<number>(12);
    const [frequency, setFrequency] = useState<number>(2);
    const [dueDay, setDueDay] = useState(10);
    const [monthlyFee, setMonthlyFee] = useState(0);
    const [isManualPrice, setIsManualPrice] = useState(false);
    const [studentLevel, setStudentLevel] = useState('A1');
    // Taxa de matrícula — paridade com o link de matrícula do dashboard
    const [chargeEnrollmentFee, setChargeEnrollmentFee] = useState(false);
    const [enrollmentFee, setEnrollmentFee] = useState(49);
    const [selectedProfessor, setSelectedProfessor] = useState('');
    const [professorSearch, setProfessorSearch] = useState('');
    const [showProfessorList, setShowProfessorList] = useState(false);

    // Class schedule (weekday + time) based on frequency
    const [classSchedule, setClassSchedule] = useState<ScheduleSlot[]>([]);

    // Pro-rata & start date
    const [enableProRata, setEnableProRata] = useState(false);
    const [billingStartMonth, setBillingStartMonth] = useState(defaultBillingStartMonthInSaoPaulo);
    const proRataEnabled = normalizeEnrollmentProRataTerms({
        enableProRata,
        planDuration: duration,
    }).enabled;

    // Generated link
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);

    // Lost Modal
    const [lostOpp, setLostOpp] = useState<Opportunity | null>(null);
    const [lostReason, setLostReason] = useState('');
    const [savingLost, setSavingLost] = useState(false);

    // Reagendamento de experimental (falta de aluno/professor)
    const [reschedOpp, setReschedOpp] = useState<Opportunity | null>(null);
    const [reschedDate, setReschedDate] = useState('');
    const [reschedTime, setReschedTime] = useState('');
    const [reschedSaving, setReschedSaving] = useState(false);

    // Filter
    const [filter, setFilter] = useState<'all' | 'OPEN' | 'WON' | 'LOST'>('all');
    // Filtro por professor: a escola usa a experimental também para COBRIR aluno
    // de outro teacher, então o diretor precisa ver o que rolou por professor.
    const [teacherFilter, setTeacherFilter] = useState<string>('all');

    // Pricing carregado do banco (com fallback hardcoded)
    const [pricingMatrix, setPricingMatrix] = useState<PricingMatrix>(pricingService.FALLBACK_PRICING);

    useEffect(() => {
        if (!tenantId) return;
        pricingService.loadPricing(tenantId).then(setPricingMatrix);
    }, [tenantId]);

    // Auto-calculate price when duration/frequency change
    useEffect(() => {
        if (isManualPrice) return;
        const price = pricingMatrix[duration]?.[frequency] || 0;
        setMonthlyFee(price);
    }, [duration, frequency, isManualPrice, pricingMatrix]);

    // Evita copiar um link antigo depois de alterar preço, plano ou agenda.
    useEffect(() => {
        setGeneratedLink('');
        setCopied(false);
    }, [
        wizardOpp?.id, duration, frequency, dueDay, monthlyFee,
        chargeEnrollmentFee, enrollmentFee, selectedProfessor,
        classSchedule, proRataEnabled, billingStartMonth,
    ]);

    // Auto-resize schedule slots based on frequency
    useEffect(() => {
        setClassSchedule(prev => {
            if (prev.length === frequency) return prev;
            if (prev.length < frequency) {
                const defaultDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const newSlots = [...prev];
                while (newSlots.length < frequency) {
                    const idx = newSlots.length;
                    newSlots.push({ weekday: defaultDays[idx] || 'monday', time: '19:00' });
                }
                return newSlots;
            }
            return prev.slice(0, frequency);
        });
    }, [frequency]);

    const enrollmentStartDate = dateInSaoPaulo();
    const proRataPreview = useMemo(() => calculateEnrollmentProRataPreview({
        enabled: proRataEnabled,
        monthlyFee,
        classesPerWeek: frequency,
        dueDay,
        billingStartMonth,
        startDate: enrollmentStartDate,
        schedule: classSchedule,
    }), [proRataEnabled, monthlyFee, frequency, dueDay, billingStartMonth, enrollmentStartDate, classSchedule]);

    const updateScheduleSlot = (index: number, field: 'weekday' | 'time', value: string) => {
        setClassSchedule(prev => {
            const updated = [...prev];
            updated[index] = { ...updated[index], [field]: value };
            return updated;
        });
    };

    // =============================================================
    // DATA FETCHING
    // =============================================================
    const fetchData = async () => {
        if (!tenantId) return;
        setLoading(true);
        setLoadError(null);
        try {
            const [opportunitiesResult, teachersResult] = await Promise.all([
                supabase
                    .from('opportunities')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .in('status', ['CLAIMED'])
                    .order('created_at', { ascending: false }),
                supabase
                    .from('profiles')
                    .select('id, full_name')
                    .eq('tenant_id', tenantId)
                    .eq('role', 'TEACHER'),
            ]);

            if (opportunitiesResult.error) throw opportunitiesResult.error;
            if (teachersResult.error) throw teachersResult.error;
            const opportunityRows = (opportunitiesResult.data || []) as Opportunity[];
            setOpportunities(opportunityRows);
            setTeachers((teachersResult.data || []) as Teacher[]);

            const oppIds = opportunityRows.map(opportunity => opportunity.id);
            if (oppIds.length === 0) {
                setFeedbacks({});
                setEnrollmentLinks({});
                setAppointments({});
                return;
            }

            const appointmentIds = opportunityRows
                .map(opportunity => opportunity.trial_appointment_id)
                .filter((id): id is string => Boolean(id));
            const nowIso = new Date().toISOString();
            const [feedbackResult, linksResult, appointmentsResult] = await Promise.all([
                supabase
                    .from('trial_feedback')
                    .select('*')
                    .in('opportunity_id', oppIds),
                supabase
                    .from('enrollment_links')
                    .select(`
                        id, tenant_id, opportunity_id, link_url, status,
                        created_at, expires_at, offer_id,
                        offer:offers!enrollment_links_offer_id_fkey(
                            id, kind, tenant_id, opportunity_id, expires_at,
                            revoked_at, consumed_at
                        )
                    `)
                    .in('opportunity_id', oppIds)
                    .eq('status', 'PENDING')
                    .gt('expires_at', nowIso)
                    .order('created_at', { ascending: false }),
                appointmentIds.length > 0
                    ? supabase
                        .from('appointments')
                        .select('id, start_time')
                        .in('id', appointmentIds)
                    : Promise.resolve({ data: [], error: null }),
            ]);

            if (feedbackResult.error) throw feedbackResult.error;
            if (linksResult.error) throw linksResult.error;
            if (appointmentsResult.error) throw appointmentsResult.error;

            const feedbackMap: Record<string, Feedback> = {};
            ((feedbackResult.data || []) as Feedback[]).forEach(feedback => {
                feedbackMap[feedback.opportunity_id] = feedback;
            });
            setFeedbacks(feedbackMap);

            const opportunityById = new Map(opportunityRows.map(opportunity => [opportunity.id, opportunity]));
            const nowMs = Date.now();
            const linkMap: Record<string, EnrollmentLink> = {};
            ((linksResult.data || []) as unknown as EnrollmentLink[]).forEach(link => {
                const opportunity = opportunityById.get(link.opportunity_id);
                if (
                    opportunity
                    && !linkMap[link.opportunity_id]
                    && isUsableEnrollmentLink(link, opportunity, nowMs)
                ) {
                    linkMap[link.opportunity_id] = link;
                }
            });
            setEnrollmentLinks(linkMap);

            const appointmentMap: Record<string, { start_time: string }> = {};
            (appointmentsResult.data || []).forEach(appointment => {
                appointmentMap[appointment.id] = { start_time: appointment.start_time };
            });
            setAppointments(appointmentMap);
        } catch (error) {
            console.error('Error loading trial conversion pipeline:', error);
            setOpportunities([]);
            setFeedbacks({});
            setEnrollmentLinks({});
            setAppointments({});
            setTeachers([]);
            setLoadError('Não foi possível carregar o fluxo autoritativo de experimentais. Nenhuma matrícula foi liberada com dados incompletos.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, [tenantId]);

    const runTrialOutcome = async (
        opportunityId: string,
        action: 'SET_TRIAL_STATUS' | 'MARK_LOST',
        fields: { trialStatus?: 'DONE' | 'NO_SHOW_STUDENT' | 'NO_SHOW_TEACHER'; lostReason?: string }
    ) => {
        const operationKey = `${opportunityId}:${action}:${fields.trialStatus || fields.lostReason || ''}`;
        const requestId = outcomeRequestIds.current[operationKey] || crypto.randomUUID();
        outcomeRequestIds.current[operationKey] = requestId;

        const p_payload = action === 'SET_TRIAL_STATUS'
            ? { requestId, opportunityId, action, trialStatus: fields.trialStatus }
            : { requestId, opportunityId, action, lostReason: fields.lostReason || null };
        const { data, error } = await supabase.rpc('update_trial_outcome_secure', { p_payload });
        if (error || data?.ok !== true) {
            const code = data?.error;
            const message = code === 'appointment_required'
                ? 'Esta experimental não possui um agendamento válido.'
                : code === 'appointment_tenant_mismatch'
                    ? 'O agendamento não pertence a esta escola ou professor.'
                    : code === 'trial_already_settled'
                        ? 'Esta experimental já foi liquidada como realizada.'
                        : code === 'tenant_not_operational'
                            ? 'A escola não está disponível para esta alteração.'
                            : error?.message || 'Não foi possível atualizar a experimental.';
            throw new Error(message);
        }
        delete outcomeRequestIds.current[operationKey];
        return data;
    };

    const markTrialRealized = async (opp: Opportunity) => {
        try {
            await runTrialOutcome(opp.id, 'SET_TRIAL_STATUS', { trialStatus: 'DONE' });
            fetchData();
        } catch (err: any) {
            alert(err.message || 'Erro ao marcar a aula como realizada.');
        }
    };

    const openReschedule = (opp: Opportunity) => {
        setReschedOpp(opp);
        setReschedDate('');
        setReschedTime('');
    };

    // Reagendar reabrindo a oportunidade ao GRUPO (re-dispara o link mágico)
    const reschedToGroup = async () => {
        if (!reschedOpp || !reschedDate || !reschedTime) { alert('Escolha data e horário.'); return; }
        setReschedSaving(true);
        try {
            const { data, error } = await supabase.functions.invoke('broadcast-opportunity', {
                body: {
                    opportunity_id: reschedOpp.id,
                    student_name: reschedOpp.student_name,
                    student_phone: reschedOpp.student_phone,
                    date: reschedDate,
                    time: reschedTime,
                    interests: (reschedOpp as any).interests || '',
                },
            });
            const parsedError = parseFunctionError({
                error,
                data,
                fallbackMessage: 'Falha ao reenviar o link.',
            });
            if (parsedError.code || parsedError.status === 409 || parsedError.status === 502 || parsedError.status === 503) {
                throw new Error(buildBroadcastErrorMessage(parsedError));
            }
            if (error || data?.error) throw new Error(data?.error || error?.message || 'Falha ao reenviar o link.');
            if (data?.warning) {
                alert(`⚠️ Oportunidade reaberta, mas FALHA no envio ao WhatsApp!\nProfessores notificados: ${data.recipients ?? 0}/${data.total_active_teachers ?? 0}\nErro: ${data.warning}`);
            } else {
                alert(`Link mágico reenviado a ${data?.recipients ?? 0} professor(es) ativo(s)! Qualquer um pode reaceitar a experimental.`);
            }
            setReschedOpp(null);
            fetchData();
        } catch (err: any) {
            alert('Erro ao reagendar: ' + err.message);
        } finally {
            setReschedSaving(false);
        }
    };

    // Solicitar a remarcação ao mesmo professor sem alterar a agenda antes do aceite.
    const reschedSameTeacher = async () => {
        if (!reschedOpp || !reschedDate || !reschedTime) { alert('Escolha data e horário.'); return; }
        if (!reschedOpp.winner_teacher_id) { alert('Esta experimental não tem professor definido. Use "Reenviar ao grupo".'); return; }
        setReschedSaving(true);
        try {
            const requestedStartTime = `${reschedDate}T${reschedTime}:00-03:00`;
            const { data, error } = await supabase.functions.invoke('school-admin', {
                body: {
                    action: 'requestTrialReschedule',
                    opportunityId: reschedOpp.id,
                    requestedStartTime,
                },
            });
            if (error || data?.error) {
                throw new Error(data?.error || error?.message || 'Falha ao solicitar a confirmação.');
            }
            alert(data?.sameTime
                ? 'Esse já é o horário atual da experimental.'
                : 'Pedido enviado ao professor. A agenda só mudará depois que ele responder SIM.');
            setReschedOpp(null);
            fetchData();
        } catch (err: any) {
            alert('Erro ao remarcar: ' + err.message);
        } finally {
            setReschedSaving(false);
        }
    };

    // =============================================================
    // COMPUTED KPIs
    // =============================================================
    const kpis = useMemo(() => {
        const total = opportunities.length;
        const won = opportunities.filter(o => o.conversion_status === 'WON').length;
        const lost = opportunities.filter(o => o.conversion_status === 'LOST').length;
        const open = opportunities.filter(o => o.conversion_status === 'OPEN').length;
        const done = opportunities.filter(o => o.trial_status === 'DONE').length;
        const linksSent = Object.keys(enrollmentLinks).length;
        const conversionRate = done > 0 ? Math.round((won / done) * 100) : 0;
        return { total, won, lost, open, done, linksSent, conversionRate };
    }, [opportunities, enrollmentLinks]);

    // =============================================================
    // FILTERED LIST
    // =============================================================
    const filtered = useMemo(() => {
        let list = opportunities;
        if (filter !== 'all') list = list.filter(o => o.conversion_status === filter);
        if (teacherFilter !== 'all') {
            list = teacherFilter === 'none'
                ? list.filter(o => !o.winner_teacher_id)
                : list.filter(o => o.winner_teacher_id === teacherFilter);
        }
        return list;
    }, [opportunities, filter, teacherFilter]);

    // Quantas experimentais cada professor pegou — some no seletor para o diretor
    // enxergar a distribuição sem precisar filtrar um por um.
    const countByTeacher = useMemo(() => {
        const map = new Map<string, number>();
        opportunities.forEach(o => {
            const key = o.winner_teacher_id || 'none';
            map.set(key, (map.get(key) || 0) + 1);
        });
        return map;
    }, [opportunities]);

    // =============================================================
    // OPEN ENROLLMENT LINK WIZARD
    // =============================================================
    const openWizard = (opp: Opportunity) => {
        if (opp.feedback_required === true && !isCompleteTrialFeedback(opp, feedbacks[opp.id])) {
            alert('O feedback da aula experimental precisa ser preenchido pelo professor antes de gerar a matrícula.');
            return;
        }
        const fb = feedbacks[opp.id];
        setWizardOpp(opp);
        setGeneratedLink('');
        setCopied(false);
        setIsManualPrice(false);
        setEnableProRata(false);
        setChargeEnrollmentFee(false);
        setEnrollmentFee(49);
        setBillingStartMonth(defaultBillingStartMonthInSaoPaulo());

        const recLevel = fb?.recommended_level?.trim()?.toUpperCase() || '';
        const validRecLevel = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(recLevel) ? recLevel : 'A1';
        setStudentLevel(validRecLevel);

        // Pré-preenche a partir do que a EXPERIMENTAL já validou (frequência + horários reais
        // capturados pelo SDR por capacidade). Fallback: feedback da aula ou 2x/semana.
        const mappedSlots: ScheduleSlot[] = (Array.isArray((opp as any).preferred_slots) ? (opp as any).preferred_slots : [])
            .map((s: any) => ({ weekday: slotToEnWeekday(s), time: String(s?.time || '').slice(0, 5) }))
            .filter((s: any) => s.weekday && /^\d{2}:\d{2}$/.test(s.time)) as ScheduleSlot[];
        const trialFreq = Number((opp as any).trial_frequency) || null;
        const freq = trialFreq || (mappedSlots.length || (fb ? planToFrequency(fb.recommended_plan) : 2));
        setFrequency(freq);
        setDuration(12); // default annual
        setDueDay(10);

        // Horários: usa os reais da experimental quando existirem; senão, o padrão antigo.
        const defaultDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const slots: ScheduleSlot[] = mappedSlots.length ? mappedSlots.slice(0, freq) : [];
        while (slots.length < freq) {
            slots.push({ weekday: defaultDays[slots.length] || 'monday', time: '19:00' });
        }
        setClassSchedule(slots);

        // Pre-fill teacher
        setSelectedProfessor(opp.winner_teacher_id || '');
        setProfessorSearch('');
        setShowProfessorList(false);
    };

    // =============================================================
    // GENERATE ENROLLMENT LINK
    // =============================================================
    const handleGenerateLink = async () => {
        if (!wizardOpp || !tenantId) return;
        if (monthlyFee <= 0) return alert("Erro: Valor inválido.");
        if (
            wizardOpp.feedback_required === true
            && !isCompleteTrialFeedback(wizardOpp, feedbacks[wizardOpp.id])
        ) {
            alert('O feedback da aula experimental ainda está pendente. Atualize a tela após o professor concluir a avaliação.');
            return;
        }

        setWizardSaving(true);

        try {
            if (!selectedProfessor) throw new Error('Selecione o professor responsável pela grade.');
            if (classSchedule.length !== frequency || classSchedule.some(slot => !slot.weekday || !/^\d{2}:\d{2}$/.test(slot.time))) {
                throw new Error(`Preencha exatamente ${frequency} horários válidos para esta oferta.`);
            }
            const scheduleKeys = classSchedule.map(slot =>
                `${weekdayIndex(slot.weekday)}|${normalizeEnrollmentTime(slot.time)}`
            );
            if (new Set(scheduleKeys).size !== scheduleKeys.length) {
                throw new Error('A grade contém duas aulas no mesmo dia e horário. Escolha horários distintos.');
            }

            // FIX: Normalizar schedule para o mesmo formato do RegistrationLinkGenerator
            // RegistrationLinkGenerator usa { day: 'Monday', time: '14:00' } (capitalizado)
            // TrialsToContracts usava { weekday: 'monday', time: '14:00' } (minúsculo)
            // PublicRegistration lê contractData.classSchedule || contractData.schedule
            // mas o formato dos campos internos precisa ser igual para o backend
            const WEEKDAY_TO_DAY: Record<string, string> = {
                'monday': 'Monday', 'tuesday': 'Tuesday', 'wednesday': 'Wednesday',
                'thursday': 'Thursday', 'friday': 'Friday', 'saturday': 'Saturday', 'sunday': 'Sunday'
            };
            const normalizedSchedule = classSchedule
                .filter(s => s.weekday)
                .map(s => ({
                    day: WEEKDAY_TO_DAY[s.weekday] || s.weekday,
                    time: s.time,
                    teacherId: selectedProfessor,
                }));

            // Build magic link data (mesma schema do RegistrationLinkGenerator)
            const data = {
                unitId: tenantId,
                value: monthlyFee,
                planDuration: duration,
                classesPerWeek: frequency,
                dueDay: dueDay,
                module: studentLevel,
                professorId: selectedProfessor || null,
                requiresEnrollment: duration !== 0,
                enrollmentFee: chargeEnrollmentFee ? enrollmentFee : 0,
                startDate: enrollmentStartDate,
                // Pro-rata & billing start month (Módulo 3)
                enableProRata: proRataEnabled,
                billingStartMonth,
                // Extra fields for opportunity tracking
                opportunityId: wizardOpp.id,
                studentName: wizardOpp.student_name,
                studentPhone: wizardOpp.student_phone,
                // Usado apenas pela RPC para salvar a URL completa que será enviada
                // nos lembretes. A RPC remove este campo do payload público.
                _linkOrigin: APP_BASE_URL,
                // Schedule normalizado (compatível com RegistrationLinkGenerator)
                schedule: normalizedSchedule.length > 0 ? normalizedSchedule : null,
            };
            const requestKey = JSON.stringify(data);
            const requestId = enrollmentOfferRequestIds.current[requestKey] || crypto.randomUUID();
            enrollmentOfferRequestIds.current[requestKey] = requestId;

            // O PublicRegistration só aceita ofertas autoritativas salvas no banco.
            // O formato legado ?data= era rejeitado (e permitia adulterar preço).
            const { data: offerId, error: offerErr } = await supabase.rpc(
                'create_enrollment_offer',
                { p_payload: { ...data, requestId } }
            );
            if (offerErr || !offerId) {
                console.error('create_enrollment_offer failed:', offerErr);
                throw offerErr || new Error('Não foi possível gerar a oferta segura de matrícula.');
            }

            const url = `${APP_BASE_URL}/matricula?offer=${offerId}`;
            delete enrollmentOfferRequestIds.current[requestKey];

            setGeneratedLink(url);

            // Copy to clipboard
            try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            } catch { /* clipboard may fail in some contexts */ }

            // Refresh data
            fetchData();

        } catch (err: any) {
            console.error('Generate Link Error:', err);
            const localMessage = err instanceof Error && /^(Selecione|Preencha|A grade)/.test(err.message)
                ? err.message
                : '';
            alert(localMessage || enrollmentCreationErrorMessage(err));
        } finally {
            setWizardSaving(false);
        }
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // =============================================================
    // MARK AS LOST
    // =============================================================
    const handleMarkLost = async () => {
        if (!lostOpp) return;
        setSavingLost(true);
        try {
            await runTrialOutcome(lostOpp.id, 'MARK_LOST', {
                lostReason: lostReason || 'Não especificado',
            });

            setLostOpp(null);
            setLostReason('');
            fetchData();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally {
            setSavingLost(false);
        }
    };

    // =============================================================
    // RENDER HELPERS
    // =============================================================
    const getTeacherName = (id: string) => teachers.find(t => t.id === id)?.full_name || 'N/A';

    const getInterestBadge = (score: number) => {
        if (score >= 4) return { label: '🔥 Quente', color: 'bg-emerald-100 text-emerald-700' };
        if (score >= 3) return { label: '🤔 Morno', color: 'bg-amber-100 text-amber-700' };
        return { label: '🥶 Frio', color: 'bg-blue-100 text-blue-700' };
    };

    const getStatusBadge = (opp: Opportunity) => {
        const link = enrollmentLinks[opp.id];
        switch (opp.conversion_status) {
            case 'WON': return { label: '✅ Convertido', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
            case 'LOST': return { label: '❌ Perdido', color: 'bg-red-100 text-red-700 border-red-200' };
            default:
                if (link && link.status === 'PENDING') return { label: '📨 Link Enviado', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' };
                return { label: '⏳ Aberto', color: 'bg-amber-100 text-amber-700 border-amber-200' };
        }
    };

    const getTrialBadge = (status: string) => {
        switch (status) {
            case 'DONE': return { label: '✅ Aula Feita', color: 'bg-emerald-50 text-emerald-600 border border-emerald-200' };
            case 'SCHEDULED': return { label: '📅 Agendada', color: 'bg-blue-50 text-blue-600 border border-blue-200' };
            case 'NO_SHOW_STUDENT': return { label: '🔴 Aluno Faltou', color: 'bg-red-50 text-red-600 border border-red-200' };
            case 'NO_SHOW_TEACHER': return { label: '🟠 Prof. Faltou', color: 'bg-orange-50 text-orange-600 border border-orange-200' };
            default: return { label: '⏳ Pendente', color: 'bg-brand-surface-2 text-brand-muted border border-brand-border' };
        }
    };

    /** Extract exact trial date/time for display */
    const getTrialDateTime = (opp: Opportunity): string | null => {
        // Priority 1: Actual appointment start_time
        if (opp.trial_appointment_id && appointments[opp.trial_appointment_id]?.start_time) {
            const dt = new Date(appointments[opp.trial_appointment_id].start_time);
            return dt.toLocaleDateString('pt-BR') + ' às ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        }
        // Priority 2: slots_proposed data (from broadcast-opportunity)
        if (opp.slots_proposed && Array.isArray(opp.slots_proposed) && opp.slots_proposed.length > 0) {
            const slot = opp.slots_proposed[0];
            if (slot.formatted && slot.time) return `${slot.formatted} às ${slot.time}`;
            if (slot.date && slot.time) {
                const parts = slot.date.split('-');
                return `${parts[2]}/${parts[1]}/${parts[0]} às ${slot.time}`;
            }
        }
        return null;
    };

    // =============================================================
    // LOADING
    // =============================================================
    if (loading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="animate-spin text-indigo-500" size={40} />
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-2xl border border-red-200 bg-red-50 p-6 text-center" role="alert">
                <AlertCircle className="text-red-600" size={32} />
                <div>
                    <h2 className="text-lg font-black text-brand-text">Experimentais indisponíveis</h2>
                    <p className="mt-2 max-w-xl text-sm font-medium text-red-700">{loadError}</p>
                </div>
                <button
                    type="button"
                    onClick={() => void fetchData()}
                    className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-xs font-black uppercase tracking-widest text-white hover:bg-red-700"
                >
                    <RefreshCw size={15} /> Tentar novamente
                </button>
            </div>
        );
    }

    // =============================================================
    // MAIN RENDER
    // =============================================================
    return (
        <div className="space-y-6">
            {/* KPI BAR */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                {[
                    { label: 'Total', value: kpis.total, icon: Users, color: 'text-brand-muted', bg: 'bg-brand-surface-2' },
                    { label: 'Aula Feita', value: kpis.done, icon: BookOpen, color: 'text-blue-600', bg: 'bg-blue-50' },
                    { label: 'Links Enviados', value: kpis.linksSent, icon: LinkIcon, color: 'text-indigo-600', bg: 'bg-indigo-50' },
                    { label: 'Convertidos', value: kpis.won, icon: Check, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                    { label: 'Perdidos', value: kpis.lost, icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
                    { label: 'Taxa Conv.', value: `${kpis.conversionRate}%`, icon: TrendingUp, color: 'text-purple-600', bg: 'bg-purple-50' },
                ].map((kpi, i) => (
                    <div key={i} className={`${kpi.bg} rounded-2xl p-4 border border-white/50`}>
                        <div className="flex items-center gap-2 mb-1">
                            <kpi.icon size={16} className={kpi.color} />
                            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">{kpi.label}</span>
                        </div>
                        <p className={`text-2xl font-black ${kpi.color}`}>{kpi.value}</p>
                    </div>
                ))}
            </div>

            {/* FILTER BAR */}
            <div className="flex gap-2 flex-wrap">
                {(['all', 'OPEN', 'WON', 'LOST'] as const).map(f => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${filter === f
                            ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                            : 'bg-brand-surface text-brand-muted border border-brand-border hover:bg-brand-surface-2'
                            }`}
                    >
                        {f === 'all' ? 'Todos' : f === 'OPEN' ? '⏳ Abertos' : f === 'WON' ? '✅ Ganhos' : '❌ Perdidos'}
                    </button>
                ))}

                <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
                    <label htmlFor="trial-teacher-filter" className="text-xs font-bold uppercase tracking-widest text-brand-muted">
                        Professor
                    </label>
                    <select
                        id="trial-teacher-filter"
                        value={teacherFilter}
                        onChange={(e) => setTeacherFilter(e.target.value)}
                        className="min-w-0 flex-1 rounded-xl border border-brand-border bg-brand-surface px-4 py-2 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-indigo-500/30 sm:flex-none"
                    >
                        <option value="all">Todos os professores ({opportunities.length})</option>
                        {teachers
                            .filter(t => countByTeacher.get(t.id))
                            .sort((a, b) => (countByTeacher.get(b.id) || 0) - (countByTeacher.get(a.id) || 0))
                            .map(t => (
                                <option key={t.id} value={t.id}>
                                    {t.full_name} ({countByTeacher.get(t.id)})
                                </option>
                            ))}
                        {countByTeacher.get('none') && (
                            <option value="none">Sem professor definido ({countByTeacher.get('none')})</option>
                        )}
                    </select>
                </div>
            </div>

            {/* PIPELINE LIST */}
            {filtered.length === 0 ? (
                <div className="text-center py-16 bg-brand-surface rounded-2xl border border-brand-border">
                    <Zap className="mx-auto text-slate-300 mb-3" size={48} />
                    <p className="text-brand-muted font-medium">Nenhuma experimental encontrada.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {filtered.map(opp => {
                        const fb = feedbacks[opp.id];
                        const link = enrollmentLinks[opp.id];
                        const sBadge = getStatusBadge(opp);
                        const tBadge = getTrialBadge(opp.trial_status);
                        const interest = fb ? getInterestBadge(fb.interest_score) : null;
                        const feedbackPending = opp.feedback_required === true
                            && !isCompleteTrialFeedback(opp, fb);

                        return (
                            <div key={opp.id} className="bg-brand-surface rounded-2xl border border-brand-border p-5 hover:shadow-lg transition-shadow">
                                <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                            <h3 className="text-lg font-bold text-brand-text truncate">{opp.student_name}</h3>
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${sBadge.color}`}>{sBadge.label}</span>
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tBadge.color}`}>{tBadge.label}</span>
                                        </div>

                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-muted">
                                            <span className="flex items-center gap-1">
                                                <Users size={12} /> {getTeacherName(opp.winner_teacher_id)}
                                            </span>
                                            {/* Exact trial datetime */}
                                            {(() => {
                                                const trialDt = getTrialDateTime(opp);
                                                return trialDt ? (
                                                    <span className="flex items-center gap-1 font-semibold text-indigo-600">
                                                        <Clock size={12} /> {trialDt}
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1">
                                                        <Calendar size={12} /> {new Date(opp.created_at).toLocaleDateString('pt-BR')}
                                                    </span>
                                                );
                                            })()}
                                            {opp.student_phone && (
                                                <span className="flex items-center gap-1">
                                                    <Phone size={12} /> {opp.student_phone}
                                                </span>
                                            )}
                                        </div>

                                        {/* Feedback Summary */}
                                        {fb && (
                                            <div className="flex gap-2 mt-3 flex-wrap">
                                                <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-indigo-50 text-indigo-600">
                                                    🎓 {fb.recommended_level}
                                                </span>
                                                <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-brand-surface-2 text-brand-muted">
                                                    📋 {fb.recommended_plan}
                                                </span>
                                                {interest && (
                                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${interest.color}`}>
                                                        {interest.label}
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {feedbackPending && opp.trial_status === 'DONE' && (
                                            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                                                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                                <span>Feedback obrigatório pendente. O professor precisa concluir a avaliação antes da matrícula.</span>
                                            </div>
                                        )}

                                        {/* Enrollment Link Status */}
                                        {link && opp.conversion_status === 'OPEN' && (
                                            <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                                                <div className="flex-1 bg-brand-surface rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                                                    <LinkIcon size={12} className="text-emerald-400 shrink-0" />
                                                    <span className="text-[10px] font-mono text-emerald-400 truncate">{link.link_url}</span>
                                                </div>
                                                <button
                                                    onClick={() => { navigator.clipboard.writeText(link.link_url); }}
                                                    className="flex w-full items-center justify-center gap-1 rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-muted transition-all hover:bg-slate-200 sm:w-auto"
                                                >
                                                    <Copy size={12} /> Copiar
                                                </button>
                                            </div>
                                        )}

                                        {opp.conversion_status === 'LOST' && opp.lost_reason && (
                                            <p className="text-xs text-red-500 mt-2 italic">Motivo: {opp.lost_reason}</p>
                                        )}
                                    </div>

                                    {/* Action Buttons */}
                                    {opp.conversion_status === 'OPEN' && (
                                        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                                            {/* Trial status actions: when NOT yet DONE */}
                                            {opp.trial_status !== 'DONE' && (
                                                <>
                                                    <button
                                                        onClick={() => markTrialRealized(opp)}
                                                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-200 transition-all hover:shadow-emerald-300 active:scale-95"
                                                    >
                                                        <Check size={16} />
                                                        Aula Realizada
                                                    </button>
                                                    <div className="flex gap-1.5">
                                                        <button
                                                            onClick={async () => {
                                                                try {
                                                                    await runTrialOutcome(opp.id, 'SET_TRIAL_STATUS', { trialStatus: 'NO_SHOW_STUDENT' });
                                                                    fetchData();
                                                                } catch (err: any) {
                                                                    alert(err.message || 'Erro ao registrar a falta do aluno.');
                                                                }
                                                            }}
                                                            className="flex-1 px-2 py-2 bg-orange-50 text-orange-600 rounded-lg text-[10px] font-bold hover:bg-orange-100 transition-all border border-orange-100"
                                                        >
                                                            Aluno Faltou
                                                        </button>
                                                        <button
                                                            onClick={async () => {
                                                                try {
                                                                    await runTrialOutcome(opp.id, 'SET_TRIAL_STATUS', { trialStatus: 'NO_SHOW_TEACHER' });
                                                                    fetchData();
                                                                } catch (err: any) {
                                                                    alert(err.message || 'Erro ao registrar a falta do professor.');
                                                                }
                                                            }}
                                                            className="flex-1 px-2 py-2 bg-orange-50 text-orange-600 rounded-lg text-[10px] font-bold hover:bg-orange-100 transition-all border border-orange-100"
                                                        >
                                                            Prof. Faltou
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                            {/* Gerar Link: only when trial DONE */}
                                            {opp.trial_status === 'DONE' && (
                                                <button
                                                    onClick={() => openWizard(opp)}
                                                    disabled={feedbackPending}
                                                    title={feedbackPending ? 'Aguardando o feedback obrigatório do professor' : undefined}
                                                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-200 transition-all hover:shadow-blue-300 active:scale-95 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-400 disabled:shadow-none"
                                                >
                                                    {feedbackPending ? <AlertCircle size={16} /> : <LinkIcon size={16} />}
                                                    {feedbackPending
                                                        ? 'Aguardando feedback'
                                                        : enrollmentLinks[opp.id]
                                                            ? 'Reenviar Link'
                                                            : 'Gerar Link Matrícula'}
                                                </button>
                                            )}
                                            {/* Reagendar: aparece quando houve falta (aluno ou professor) */}
                                            {(opp.trial_status === 'NO_SHOW_STUDENT' || opp.trial_status === 'NO_SHOW_TEACHER') && (
                                                <button
                                                    onClick={() => openReschedule(opp)}
                                                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-amber-200 transition-all hover:shadow-amber-300 active:scale-95"
                                                >
                                                    <RefreshCw size={16} />
                                                    Reagendar Experimental
                                                </button>
                                            )}
                                            {/* Perdido: always visible when OPEN */}
                                            <button
                                                onClick={() => { setLostOpp(opp); setLostReason(''); }}
                                                className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-600 transition-all hover:bg-red-100"
                                            >
                                                <XCircle size={16} />
                                                Perdido
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ============================================= */}
            {/* ENROLLMENT LINK WIZARD MODAL */}
            {/* ============================================= */}
            {wizardOpp && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-brand-surface rounded-3xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                        {/* Header */}
                        <div className="bg-gradient-to-r from-[#002366] to-blue-900 rounded-t-3xl p-6 text-white relative overflow-hidden">
                            <button onClick={() => setWizardOpp(null)} className="absolute top-4 right-4 p-2 rounded-xl bg-brand-surface/10 hover:bg-brand-surface/20 transition-colors">
                                <X size={18} />
                            </button>
                            <div className="relative z-10">
                                <div className="flex items-center gap-3 mb-2">
                                    <Sparkles className="text-blue-300 animate-pulse" size={24} />
                                    <div>
                                        <p className="text-[10px] tracking-wider font-bold opacity-70 uppercase">Gerar Link de Matrícula</p>
                                        <h2 className="text-xl font-black">{wizardOpp.student_name}</h2>
                                    </div>
                                </div>

                                {/* Origin indicator */}
                                <div className="mt-3 bg-brand-surface/10 backdrop-blur-md rounded-xl px-4 py-2 inline-flex items-center gap-2">
                                    <Zap size={14} className="text-yellow-300" />
                                    <span className="text-xs font-medium text-blue-100">
                                        Origem: Aula Experimental com {getTeacherName(wizardOpp.winner_teacher_id)} em {new Date(wizardOpp.created_at).toLocaleDateString('pt-BR')}
                                    </span>
                                </div>

                                {/* Feedback pre-fill indicator */}
                                {feedbacks[wizardOpp.id] && (
                                    <div className="mt-2 flex gap-2 flex-wrap">
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-brand-surface/10 text-blue-200">
                                            🎓 Nível: {feedbacks[wizardOpp.id].recommended_level}
                                        </span>
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-brand-surface/10 text-blue-200">
                                            📋 Plano: {feedbacks[wizardOpp.id].recommended_plan}
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                        </div>

                        <div className="p-6 space-y-6">
                            {/* SECTION 1: PLAN SELECTION */}
                            <div>
                                <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2 mb-4">
                                    <Wallet size={14} /> Selecione o Plano e Frequência
                                </h3>

                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                    {/* Plan Duration Cards */}
                                    <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        {[
                                            { val: 12, label: 'Anual', sub: '12 Meses' },
                                            { val: 6, label: 'Semestral', sub: '6 Meses' },
                                            { val: 1, label: 'Mensal', sub: 'Sem Fidelidade' }
                                        ].map((plan) => (
                                            <button
                                                key={plan.val}
                                                onClick={() => setDuration(plan.val)}
                                                className={`relative p-3 rounded-2xl border-2 text-left transition-all hover:scale-[1.02] ${duration === plan.val
                                                    ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-600 ring-offset-2'
                                                    : 'border-brand-border bg-brand-surface-2 text-brand-muted hover:border-brand-border'
                                                    }`}
                                            >
                                                {duration === plan.val && (
                                                    <div className="absolute -top-2 -right-2 bg-blue-600 text-white p-1 rounded-full shadow-sm">
                                                        <Check size={10} strokeWidth={4} />
                                                    </div>
                                                )}
                                                <span className={`block text-sm font-black ${duration === plan.val ? 'text-blue-700' : 'text-brand-muted'}`}>
                                                    {plan.label}
                                                </span>
                                                <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">{plan.sub}</span>
                                            </button>
                                        ))}
                                    </div>

                                    {/* Frequency, Due Day & Level */}
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Frequência</label>
                                                <select
                                                    value={frequency}
                                                    onChange={(e) => setFrequency(Number(e.target.value))}
                                                    className="w-full px-3 py-2.5 bg-brand-surface-2 border-none rounded-xl font-bold text-sm text-brand-text appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                                >
                                                    {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}x na Semana</option>)}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">Vencimento</label>
                                                <select
                                                    value={dueDay}
                                                    onChange={(e) => setDueDay(Number(e.target.value))}
                                                    className="w-full px-3 py-2.5 bg-brand-surface-2 border-none rounded-xl font-bold text-sm text-brand-text appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                                >
                                                    {[5, 10, 15, 20, 25, 30].map(d => <option key={d} value={d}>Dia {d}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold uppercase text-brand-muted mb-1 block">
                                                Nível Pedagógico
                                            </label>
                                            <select
                                                value={studentLevel}
                                                onChange={(e) => setStudentLevel(e.target.value)}
                                                className="w-full px-3 py-2.5 bg-brand-surface-2 border-none rounded-xl font-bold text-sm text-brand-text appearance-none outline-none focus:ring-2 focus:ring-blue-500"
                                            >
                                                <option value="A1">A1 - Iniciante (A1-1)</option>
                                                <option value="A2">A2 - Elementar (A2-1)</option>
                                                <option value="B1">B1 - Intermediário (B1-1)</option>
                                                <option value="B2">B2 - Independente (B2-1)</option>
                                                <option value="C1">C1 - Avançado (C1-1)</option>
                                                <option value="C2">C2 - Proficiente (C2-1)</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                {/* Price Display */}
                                <div className="mt-4 flex items-center justify-between bg-emerald-50 rounded-xl p-3 border border-emerald-100">
                                    <div className="flex items-center gap-2">
                                        <DollarSign size={16} className="text-emerald-600" />
                                        <span className="text-sm font-bold text-emerald-700">
                                            R$ {monthlyFee.toFixed(2)}/mês
                                        </span>
                                    </div>
                                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-brand-muted cursor-pointer hover:text-blue-500 transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={isManualPrice}
                                            onChange={(e) => setIsManualPrice(e.target.checked)}
                                            className="rounded text-blue-600 focus:ring-blue-500"
                                        />
                                        Manual
                                    </label>
                                </div>

                                {isManualPrice && (
                                    <div className="mt-2 relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted font-bold text-sm">R$</span>
                                        <input
                                            type="number"
                                            value={monthlyFee}
                                            onChange={(e) => setMonthlyFee(Number(e.target.value))}
                                            className="w-full pl-10 pr-4 py-3 bg-blue-50 border border-blue-200 rounded-xl font-black text-blue-700 outline-none focus:ring-2 focus:ring-blue-500"
                                            placeholder="0.00"
                                        />
                                    </div>
                                )}
                            </div>

                            {/* SECTION: CLASS SCHEDULE */}
                            <div className="bg-brand-surface-2 rounded-2xl p-4 border border-brand-border">
                                <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2 mb-3">
                                    <Calendar size={14} /> Dias e Horários das Aulas ({frequency}x/semana)
                                </h3>
                                <div className="space-y-2">
                                    {classSchedule.map((slot, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-brand-muted w-5 text-center">{idx + 1}.</span>
                                            <select
                                                value={slot.weekday}
                                                onChange={(e) => updateScheduleSlot(idx, 'weekday', e.target.value)}
                                                className="flex-1 px-3 py-2.5 bg-brand-surface border border-brand-border rounded-xl text-sm font-medium text-brand-text appearance-none outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10"
                                            >
                                                {WEEKDAY_OPTIONS.map(d => (
                                                    <option key={d.value} value={d.value}>{d.label}</option>
                                                ))}
                                            </select>
                                            <input
                                                type="time"
                                                value={slot.time}
                                                onChange={(e) => updateScheduleSlot(idx, 'time', e.target.value)}
                                                className="w-28 px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-xl font-bold text-sm text-blue-700 text-center outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* SECTION 2: PROFESSOR */}
                            <div className="bg-brand-surface-2 rounded-2xl p-4 border border-brand-border">
                                <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2 mb-3">
                                    <Award size={14} /> Professor Responsável
                                </h3>

                                <div className="relative z-50">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={16} />
                                    <input
                                        type="text"
                                        placeholder="Buscar Professor..."
                                        value={selectedProfessor ? (teachers.find(p => p.id === selectedProfessor)?.full_name || '') : professorSearch}
                                        onChange={(e) => {
                                            setProfessorSearch(e.target.value);
                                            setSelectedProfessor('');
                                            setShowProfessorList(true);
                                        }}
                                        onFocus={() => { setProfessorSearch(''); setShowProfessorList(true); }}
                                        className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-medium text-brand-text outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/10 transition-all shadow-sm cursor-pointer"
                                    />
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" size={16} />

                                    {showProfessorList && (
                                        <>
                                            <div className="fixed inset-0 z-40" onClick={() => setShowProfessorList(false)} />
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-brand-surface border border-brand-border rounded-xl shadow-xl max-h-60 overflow-y-auto z-50">
                                                {teachers.filter(p => !professorSearch || p.full_name.toLowerCase().includes(professorSearch.toLowerCase())).length > 0 ? (
                                                    teachers
                                                        .filter(p => !professorSearch || p.full_name.toLowerCase().includes(professorSearch.toLowerCase()))
                                                        .map(p => (
                                                            <button
                                                                key={p.id}
                                                                onClick={() => {
                                                                    setSelectedProfessor(p.id);
                                                                    setShowProfessorList(false);
                                                                    setProfessorSearch('');
                                                                }}
                                                                className="w-full text-left px-4 py-3 hover:bg-brand-surface-2 text-brand-text text-sm font-medium transition-colors flex items-center justify-between"
                                                            >
                                                                {p.full_name}
                                                                {selectedProfessor === p.id && <Check size={14} className="text-purple-500" />}
                                                            </button>
                                                        ))
                                                ) : (
                                                    <div className="p-4 text-center text-brand-muted text-xs">Nenhum professor encontrado.</div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>

                                {wizardOpp.winner_teacher_id === selectedProfessor && selectedProfessor && (
                                    <p className="text-xs text-emerald-600 mt-2 font-medium flex items-center gap-1">
                                        <Check size={12} /> Professor da aula experimental
                                    </p>
                                )}
                            </div>

                            {/* SECTION: PRO-RATA & BILLING START */}
                            <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
                                <h3 className="text-xs font-black text-amber-700 uppercase tracking-widest flex items-center gap-2 mb-3">
                                    <Calendar size={14} /> Início de Cobrança
                                </h3>
                                <div className="space-y-3">
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Mês de início da mensalidade</label>
                                        <input
                                            type="month"
                                            value={billingStartMonth}
                                            min={dateInSaoPaulo().slice(0, 7)}
                                            onChange={(e) => setBillingStartMonth(e.target.value)}
                                            className="w-full px-3 py-2.5 bg-white border border-amber-200 rounded-xl font-bold text-sm text-slate-700 outline-none focus:ring-2 focus:ring-amber-500"
                                        />
                                        <p className="text-[9px] text-slate-400 mt-1">Deixe como próximo mês para iniciar normalmente, ou escolha um mês futuro para diferir a cobrança.</p>
                                    </div>

                                    <div className={`flex items-start gap-3 ${duration === 0 ? 'opacity-60' : ''}`}>
                                        <EnrollmentProRataSwitch
                                            checked={proRataEnabled}
                                            disabled={duration === 0}
                                            label="Cobrar pró-rata nesta matrícula"
                                            onCheckedChange={setEnableProRata}
                                        />
                                        <div>
                                            <p className="text-sm font-bold text-slate-700">Cobrar pró-rata</p>
                                            <p className="text-xs text-slate-400">
                                                {duration === 0
                                                    ? 'Não se aplica ao plano de aula avulsa.'
                                                    : proRataEnabled
                                                        ? `Ativado: cálculo por aula entre o início e ${proRataPreview.firstBillingDate.split('-').reverse().join('/')}.`
                                                        : 'Desativado: não haverá cobrança proporcional antes da primeira mensalidade.'}
                                            </p>
                                            {proRataEnabled && monthlyFee > 0 && (
                                                <p className="text-xs text-amber-600 font-bold">
                                                    R$ {proRataPreview.pricePerClass.toFixed(2)}/aula × {proRataPreview.classCount} aulas = R$ {proRataPreview.value.toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* SECTION: TAXA DE MATRÍCULA */}
                            <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <div className="relative">
                                            <input
                                                type="checkbox"
                                                checked={chargeEnrollmentFee}
                                                onChange={(e) => setChargeEnrollmentFee(e.target.checked)}
                                                className="sr-only"
                                            />
                                            <div className={`w-10 h-6 rounded-full transition-colors ${chargeEnrollmentFee ? 'bg-blue-600' : 'bg-slate-200'}`} />
                                            <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${chargeEnrollmentFee ? 'translate-x-4' : ''}`} />
                                        </div>
                                        <span className="text-sm font-bold text-slate-700">Cobrar Taxa de Matrícula</span>
                                    </label>
                                    {chargeEnrollmentFee && (
                                        <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-blue-200">
                                            <span className="text-[10px] font-black text-blue-600">R$</span>
                                            <input
                                                type="number"
                                                value={enrollmentFee}
                                                onChange={(e) => setEnrollmentFee(Number(e.target.value))}
                                                className="w-14 bg-transparent border-none p-0 text-sm font-black text-blue-700 outline-none focus:ring-0"
                                            />
                                        </div>
                                    )}
                                </div>
                                <p className="text-[9px] text-slate-400 font-medium">
                                    {chargeEnrollmentFee
                                        ? `O aluno deverá pagar R$ ${enrollmentFee.toFixed(2)} via Pix para garantir a vaga (cobrado após a assinatura).`
                                        : 'A taxa de matrícula não será cobrada neste link.'}
                                </p>
                            </div>

                            {/* GENERATE BUTTON & RESULT */}
                            <div>
                                {!generatedLink ? (
                                    <button
                                        onClick={handleGenerateLink}
                                        disabled={monthlyFee <= 0 || wizardSaving}
                                        className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-blue-500/20 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                                    >
                                        {wizardSaving ? (
                                            <><Loader2 className="animate-spin" size={18} /> Gerando...</>
                                        ) : (
                                            <><Sparkles size={18} /> Gerar Link Mágico</>
                                        )}
                                    </button>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="bg-brand-surface rounded-2xl p-4 flex items-center gap-4 border border-brand-border shadow-2xl">
                                            <LinkIcon size={20} className="text-emerald-400 shrink-0" />
                                            <div className="flex-1 overflow-hidden">
                                                <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider mb-1">
                                                    Link Gerado com Sucesso ✨
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

                                        <p className="text-center text-[10px] text-brand-muted font-medium">
                                            Envie esse link para o aluno via WhatsApp. Ao completar a matrícula, a experimental será marcada como convertida.
                                        </p>

                                        <button
                                            onClick={() => setWizardOpp(null)}
                                            className="w-full py-3 bg-brand-surface-2 text-brand-muted rounded-xl font-bold hover:bg-slate-200 transition-all"
                                        >
                                            Fechar
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ============================================= */}
            {/* RESCHEDULE MODAL (experimental com falta) */}
            {/* ============================================= */}
            {reschedOpp && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-brand-surface rounded-3xl shadow-2xl max-w-md w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center">
                                <RefreshCw size={24} className="text-amber-600" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-brand-text">Reagendar Experimental</h3>
                                <p className="text-xs text-brand-muted">{reschedOpp.student_name}</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                            <div>
                                <label className="text-[10px] font-bold uppercase text-brand-muted block mb-1">Nova data</label>
                                <input type="date" value={reschedDate} onChange={e => setReschedDate(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-brand-surface-2 dark:bg-slate-800 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-amber-500" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold uppercase text-brand-muted block mb-1">Horário</label>
                                <input type="time" value={reschedTime} onChange={e => setReschedTime(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-brand-surface-2 dark:bg-slate-800 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-amber-500" />
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <button
                                onClick={reschedToGroup}
                                disabled={reschedSaving}
                                className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {reschedSaving ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                                Reenviar ao grupo (link mágico)
                            </button>
                            <button
                                onClick={reschedSameTeacher}
                                disabled={reschedSaving}
                                className="w-full py-3 bg-blue-50 text-blue-600 border border-blue-100 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-blue-100 disabled:opacity-50"
                            >
                                <Check size={16} />
                                Pedir confirmação ao professor atual
                            </button>
                            <button onClick={() => setReschedOpp(null)} className="w-full py-2 text-brand-muted font-bold text-xs uppercase tracking-widest">
                                Cancelar
                            </button>
                        </div>
                        <p className="text-[10px] text-brand-muted text-center mt-3">
                            "Reenviar ao grupo" reabre a vaga para outro aceite. Para manter o professor atual, a agenda só muda após a confirmação dele.
                        </p>
                    </div>
                </div>
            )}

            {/* ============================================= */}
            {/* LOST MODAL */}
            {/* ============================================= */}
            {lostOpp && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-brand-surface rounded-3xl shadow-2xl max-w-md w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-12 h-12 rounded-2xl bg-red-100 flex items-center justify-center">
                                <XCircle size={24} className="text-red-500" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-brand-text">Marcar como Perdido</h3>
                                <p className="text-xs text-brand-muted">{lostOpp.student_name}</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <label className="text-xs font-bold text-brand-muted uppercase tracking-wider block">Motivo</label>
                            <div className="grid grid-cols-2 gap-2">
                                {['Preço', 'Horário', 'Desinteresse', 'Concorrência', 'Outro'].map(reason => (
                                    <button
                                        key={reason}
                                        onClick={() => setLostReason(reason)}
                                        className={`py-2.5 px-3 rounded-xl text-sm font-semibold transition-all ${lostReason === reason
                                            ? 'bg-red-500 text-white shadow-lg shadow-red-200'
                                            : 'bg-brand-surface-2 text-brand-muted hover:bg-slate-200'
                                            }`}
                                    >
                                        {reason}
                                    </button>
                                ))}
                            </div>

                            {lostReason === 'Outro' && (
                                <input
                                    value={lostReason}
                                    onChange={e => setLostReason(e.target.value)}
                                    placeholder="Descreva o motivo..."
                                    className="w-full px-4 py-3 rounded-xl border border-brand-border text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent"
                                />
                            )}
                        </div>

                        <div className="flex gap-2 mt-6">
                            <button onClick={() => setLostOpp(null)}
                                className="flex-1 py-3 bg-brand-surface-2 text-brand-muted rounded-xl font-bold hover:bg-slate-200 transition-all">
                                Cancelar
                            </button>
                            <button
                                onClick={handleMarkLost}
                                disabled={!lostReason || savingLost}
                                className="flex-1 py-3 bg-red-500 text-white rounded-xl font-bold shadow-lg shadow-red-200 active:scale-95 transition-all disabled:opacity-50"
                            >
                                {savingLost ? 'Salvando...' : 'Confirmar'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrialsToContracts;
