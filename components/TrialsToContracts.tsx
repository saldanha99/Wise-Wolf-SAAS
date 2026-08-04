import React, { useState, useEffect, useMemo } from 'react';
import {
    Zap, Users, ArrowRight, Check, X, Star, BookOpen, DollarSign,
    UserPlus, Award, TrendingUp, AlertCircle, Loader2, Phone,
    Mail, ChevronRight, Calendar, ThermometerSun, FileText, XCircle,
    Link as LinkIcon, Copy, Sparkles, Wallet, ChevronDown, Search, Clock, RefreshCw
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { pricingService, PricingMatrix } from '../services/pricingService';

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
    trial_appointment_id: string;
    student_id: string | null;
    lost_reason: string | null;
    created_at: string;
    slots_proposed: any;
    accepted_slot: any;
}

interface Feedback {
    id: string;
    opportunity_id: string;
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
    opportunity_id: string;
    link_url: string;
    status: string;
    created_at: string;
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
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [feedbacks, setFeedbacks] = useState<Record<string, Feedback>>({});
    const [teachers, setTeachers] = useState<Teacher[]>([]);
    const [enrollmentLinks, setEnrollmentLinks] = useState<Record<string, EnrollmentLink>>({});
    const [appointments, setAppointments] = useState<Record<string, { start_time: string }>>({});

    // Wizard State (Enrollment Link Modal)
    const [wizardOpp, setWizardOpp] = useState<Opportunity | null>(null);
    const [wizardSaving, setWizardSaving] = useState(false);

    // Wizard Form Data
    const [duration, setDuration] = useState<number>(12);
    const [frequency, setFrequency] = useState<number>(2);
    const [dueDay, setDueDay] = useState(10);
    const [monthlyFee, setMonthlyFee] = useState(0);
    const [isManualPrice, setIsManualPrice] = useState(false);
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
    const [billingStartMonth, setBillingStartMonth] = useState(() => {
        const now = new Date();
        // Default to next month if we're past the 15th
        if (now.getDate() > 15) {
            now.setMonth(now.getMonth() + 1);
        }
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

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
        classSchedule, enableProRata, billingStartMonth,
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

        // 1. All opportunities with trial data
        const { data: opps } = await supabase
            .from('opportunities')
            .select('*')
            .eq('tenant_id', tenantId)
            .in('status', ['CLAIMED'])
            .order('created_at', { ascending: false });

        setOpportunities(opps || []);

        // 2. Feedbacks for those opportunities
        const oppIds = (opps || []).map(o => o.id);
        if (oppIds.length > 0) {
            const { data: fbs } = await supabase
                .from('trial_feedback')
                .select('*')
                .in('opportunity_id', oppIds);

            const fbMap: Record<string, Feedback> = {};
            (fbs || []).forEach(f => { fbMap[f.opportunity_id] = f; });
            setFeedbacks(fbMap);

            // 3. Enrollment links for those opportunities
            const { data: links } = await supabase
                .from('enrollment_links')
                .select('*')
                .in('opportunity_id', oppIds)
                .eq('status', 'PENDING')
                .order('created_at', { ascending: false });

            const linkMap: Record<string, EnrollmentLink> = {};
            (links || []).forEach(l => {
                if (!linkMap[l.opportunity_id]) {
                    linkMap[l.opportunity_id] = l;
                }
            });
            setEnrollmentLinks(linkMap);

            // 4. Fetch appointment start_time for exact trial time
            const appointmentIds = (opps || []).map(o => o.trial_appointment_id).filter(Boolean);
            if (appointmentIds.length > 0) {
                const { data: appts } = await supabase
                    .from('appointments')
                    .select('id, start_time')
                    .in('id', appointmentIds);

                const apptMap: Record<string, { start_time: string }> = {};
                (appts || []).forEach(a => {
                    // Map by opportunity's trial_appointment_id
                    apptMap[a.id] = { start_time: a.start_time };
                });
                setAppointments(apptMap);
            }
        }

        // 4. Teachers
        const { data: tchrs } = await supabase
            .from('profiles')
            .select('id, full_name')
            .eq('tenant_id', tenantId)
            .eq('role', 'TEACHER');

        setTeachers(tchrs || []);
        setLoading(false);
    };

    useEffect(() => { fetchData(); }, [tenantId]);

    // Marca experimental como realizada E lança a aula na folha do professor.
    // Regra: só contabiliza quando a aula foi realizada (presence COMPLETED).
    // Se aluno OU professor faltar, NÃO lança class_log (não contabiliza).
    const markTrialRealized = async (opp: Opportunity) => {
        // 1. Atualiza status da oportunidade
        await supabase.from('opportunities').update({ trial_status: 'DONE' }).eq('id', opp.id);

        // 2. Lança a aula experimental na folha do professor vencedor (se houver)
        if (opp.winner_teacher_id) {
            // Dedupe: evita lançar duas vezes a mesma experimental
            const apptId = opp.trial_appointment_id || `trial_${opp.id}`;
            const { data: jaExiste } = await supabase
                .from('class_logs')
                .select('id')
                .eq('appointment_id', apptId)
                .maybeSingle();

            if (!jaExiste) {
                const startAt = opp.trial_appointment_id ? appointments[opp.trial_appointment_id]?.start_time : null;
                const classDate = (startAt ? new Date(startAt) : new Date()).toISOString().split('T')[0];
                await supabase.from('class_logs').insert({
                    tenant_id: tenantId,
                    teacher_id: opp.winner_teacher_id,
                    student_id: null, // lead de experimental ainda não é aluno
                    date: classDate,
                    class_date: classDate,
                    presence: 'COMPLETED',
                    subtype: 'AULA EXPERIMENTAL',
                    appointment_id: apptId,
                    content: `Aula experimental — ${opp.student_name || 'Lead'}`,
                });
            }
        }
        fetchData();
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

    // Reagendar MANTENDO o mesmo professor (sem passar pelo grupo)
    const reschedSameTeacher = async () => {
        if (!reschedOpp || !reschedDate || !reschedTime) { alert('Escolha data e horário.'); return; }
        if (!reschedOpp.winner_teacher_id) { alert('Esta experimental não tem professor definido. Use "Reenviar ao grupo".'); return; }
        setReschedSaving(true);
        try {
            const isoDate = new Date(`${reschedDate}T${reschedTime}:00`).toISOString();
            const formatted = `${reschedDate.split('-').reverse().join('/')} às ${reschedTime}`;

            // Reabre a experimental como agendada, mantendo o professor
            const { error: oppErr } = await supabase.from('opportunities').update({
                trial_status: 'SCHEDULED',
                conversion_status: 'OPEN',
                slots_proposed: [{ time: reschedTime, date: reschedDate, formatted }],
            }).eq('id', reschedOpp.id);
            if (oppErr) throw oppErr;

            // Remarca o agendamento do trial (appointments) se existir
            if (reschedOpp.trial_appointment_id) {
                await supabase.from('appointments')
                    .update({ start_time: isoDate, status: 'scheduled' })
                    .eq('id', reschedOpp.trial_appointment_id);
            }

            alert('Experimental remarcada com o mesmo professor.');
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
        const fb = feedbacks[opp.id];
        setWizardOpp(opp);
        setGeneratedLink('');
        setCopied(false);
        setIsManualPrice(false);
        setEnableProRata(false);
        setChargeEnrollmentFee(false);
        setEnrollmentFee(49);
        const now = new Date();
        if (now.getDate() > 15) now.setMonth(now.getMonth() + 1);
        setBillingStartMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);

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

        setWizardSaving(true);

        try {
            // Calcular pro-rata baseado em aulas avulsas
            // Fórmula: (mensalidade / frequência×4) × aulas restantes no mês
            const today = new Date();
            const proRataValue = enableProRata ? (() => {
                const totalClassesPerMonth = frequency * 4;
                const pricePerClass = monthlyFee / totalClassesPerMonth;

                // Mapear dias do horário para getDay() (0=Dom, 1=Seg, ..., 6=Sáb)
                const DAY_MAP: Record<string, number> = {
                    'monday': 1, 'tuesday': 2, 'wednesday': 3,
                    'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 0
                };
                const classDayNums = new Set(
                    classSchedule.filter(s => s.weekday).map(s => DAY_MAP[s.weekday]).filter(d => d !== undefined)
                );

                let remainingClasses = 0;
                if (classDayNums.size > 0) {
                    // Contar dias reais do horário de hoje até o fim do mês
                    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    const cursor = new Date(today);
                    while (cursor <= endOfMonth) {
                        if (classDayNums.has(cursor.getDay())) remainingClasses++;
                        cursor.setDate(cursor.getDate() + 1);
                    }
                } else {
                    // Sem horário definido: estimar proporcionalmente
                    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                    const remainingDays = daysInMonth - today.getDate() + 1;
                    remainingClasses = Math.round((frequency / 7) * remainingDays);
                }

                return Math.round(pricePerClass * remainingClasses * 100) / 100;
            })() : 0;

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
                .map(s => ({ day: WEEKDAY_TO_DAY[s.weekday] || s.weekday, time: s.time }));

            // Build magic link data (mesma schema do RegistrationLinkGenerator)
            const data = {
                unitId: tenantId,
                value: monthlyFee,
                planDuration: duration,
                classesPerWeek: frequency,
                dueDay: dueDay,
                professorId: selectedProfessor || null,
                requiresEnrollment: duration !== 0,
                enrollmentFee: chargeEnrollmentFee ? enrollmentFee : 0,
                startDate: new Date().toISOString().split('T')[0], // Data de hoje como início
                // Pro-rata & billing start month (Módulo 3)
                enableProRata,
                proRataValue: enableProRata ? proRataValue : undefined,
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

            // O PublicRegistration só aceita ofertas autoritativas salvas no banco.
            // O formato legado ?data= era rejeitado (e permitia adulterar preço).
            const { data: offerId, error: offerErr } = await supabase.rpc(
                'create_enrollment_offer',
                { p_payload: data }
            );
            if (offerErr || !offerId) {
                console.error('create_enrollment_offer failed:', offerErr);
                throw new Error('Não foi possível gerar a oferta segura de matrícula.');
            }

            const url = `${APP_BASE_URL}/matricula?offer=${offerId}`;

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
            alert(err.message || 'Erro ao gerar link.');
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
            await supabase
                .from('opportunities')
                .update({
                    conversion_status: 'LOST',
                    lost_reason: lostReason || 'Não especificado',
                })
                .eq('id', lostOpp.id);

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

                <div className="flex items-center gap-2 ml-auto">
                    <label htmlFor="trial-teacher-filter" className="text-xs font-bold uppercase tracking-widest text-brand-muted">
                        Professor
                    </label>
                    <select
                        id="trial-teacher-filter"
                        value={teacherFilter}
                        onChange={(e) => setTeacherFilter(e.target.value)}
                        className="rounded-xl border border-brand-border bg-brand-surface px-4 py-2 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-indigo-500/30"
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

                        return (
                            <div key={opp.id} className="bg-brand-surface rounded-2xl border border-brand-border p-5 hover:shadow-lg transition-shadow">
                                <div className="flex items-start justify-between gap-4">
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

                                        {/* Enrollment Link Status */}
                                        {link && opp.conversion_status === 'OPEN' && (
                                            <div className="mt-3 flex items-center gap-2">
                                                <div className="flex-1 bg-brand-surface rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                                                    <LinkIcon size={12} className="text-emerald-400 shrink-0" />
                                                    <span className="text-[10px] font-mono text-emerald-400 truncate">{link.link_url}</span>
                                                </div>
                                                <button
                                                    onClick={() => { navigator.clipboard.writeText(link.link_url); }}
                                                    className="px-3 py-2 bg-brand-surface-2 rounded-xl text-xs font-bold text-brand-muted hover:bg-slate-200 transition-all flex items-center gap-1"
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
                                        <div className="flex flex-col gap-2 shrink-0">
                                            {/* Trial status actions: when NOT yet DONE */}
                                            {opp.trial_status !== 'DONE' && (
                                                <>
                                                    <button
                                                        onClick={() => markTrialRealized(opp)}
                                                        className="px-4 py-2.5 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-200 hover:shadow-emerald-300 active:scale-95 transition-all flex items-center gap-2"
                                                    >
                                                        <Check size={16} />
                                                        Aula Realizada
                                                    </button>
                                                    <div className="flex gap-1.5">
                                                        <button
                                                            onClick={async () => {
                                                                await supabase.from('opportunities').update({ trial_status: 'NO_SHOW_STUDENT' }).eq('id', opp.id);
                                                                fetchData();
                                                            }}
                                                            className="flex-1 px-2 py-2 bg-orange-50 text-orange-600 rounded-lg text-[10px] font-bold hover:bg-orange-100 transition-all border border-orange-100"
                                                        >
                                                            Aluno Faltou
                                                        </button>
                                                        <button
                                                            onClick={async () => {
                                                                await supabase.from('opportunities').update({ trial_status: 'NO_SHOW_TEACHER' }).eq('id', opp.id);
                                                                fetchData();
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
                                                    className="px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-blue-200 hover:shadow-blue-300 active:scale-95 transition-all flex items-center gap-2"
                                                >
                                                    <LinkIcon size={16} />
                                                    {enrollmentLinks[opp.id] ? 'Reenviar Link' : 'Gerar Link Matrícula'}
                                                </button>
                                            )}
                                            {/* Reagendar: aparece quando houve falta (aluno ou professor) */}
                                            {(opp.trial_status === 'NO_SHOW_STUDENT' || opp.trial_status === 'NO_SHOW_TEACHER') && (
                                                <button
                                                    onClick={() => openReschedule(opp)}
                                                    className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-amber-200 hover:shadow-amber-300 active:scale-95 transition-all flex items-center gap-2"
                                                >
                                                    <RefreshCw size={16} />
                                                    Reagendar Experimental
                                                </button>
                                            )}
                                            {/* Perdido: always visible when OPEN */}
                                            <button
                                                onClick={() => { setLostOpp(opp); setLostReason(''); }}
                                                className="px-4 py-2.5 bg-red-50 text-red-600 rounded-xl text-sm font-bold hover:bg-red-100 transition-all flex items-center gap-2 border border-red-100"
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

                                    {/* Frequency & Due Day */}
                                    <div className="space-y-3">
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
                                            onChange={(e) => setBillingStartMonth(e.target.value)}
                                            className="w-full px-3 py-2.5 bg-white border border-amber-200 rounded-xl font-bold text-sm text-slate-700 outline-none focus:ring-2 focus:ring-amber-500"
                                        />
                                        <p className="text-[9px] text-slate-400 mt-1">Deixe como próximo mês para iniciar normalmente, ou escolha um mês futuro para diferir a cobrança.</p>
                                    </div>

                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <div className="relative">
                                            <input
                                                type="checkbox"
                                                checked={enableProRata}
                                                onChange={(e) => setEnableProRata(e.target.checked)}
                                                className="sr-only"
                                            />
                                            <div className={`w-10 h-6 rounded-full transition-colors ${enableProRata ? 'bg-amber-500' : 'bg-slate-200'}`} />
                                            <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${enableProRata ? 'translate-x-4' : ''}`} />
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-slate-700">Cobrar Pro-Rata do mês atual</p>
                                            <p className="text-xs text-slate-400">Cobrança por aulas avulsas (mensalidade ÷ {frequency * 4} aulas)</p>
                                            {enableProRata && monthlyFee > 0 && (
                                                <p className="text-xs text-amber-600 font-bold">
                                                    {(() => {
                                                        const totalAulas = frequency * 4;
                                                        const valorAula = monthlyFee / totalAulas;
                                                        const DAY_MAP: Record<string, number> = {
                                                            'monday': 1, 'tuesday': 2, 'wednesday': 3,
                                                            'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 0
                                                        };
                                                        const validDays = new Set(
                                                            classSchedule.filter(s => s.weekday).map(s => DAY_MAP[s.weekday]).filter(d => d !== undefined)
                                                        );
                                                        const today = new Date();
                                                        let aulasRestantes = 0;
                                                        if (validDays.size > 0) {
                                                            const fim = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                                                            const c = new Date(today);
                                                            while (c <= fim) {
                                                                if (validDays.has(c.getDay())) aulasRestantes++;
                                                                c.setDate(c.getDate() + 1);
                                                            }
                                                        } else {
                                                            const dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                                                            aulasRestantes = Math.round((frequency / 7) * (dim - today.getDate() + 1));
                                                        }
                                                        const total = (valorAula * aulasRestantes).toFixed(2);
                                                        return `R$ ${valorAula.toFixed(2)}/aula × ${aulasRestantes} aulas = R$ ${total}`;
                                                    })()}
                                                </p>
                                            )}
                                        </div>
                                    </label>
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
                                Manter o mesmo professor
                            </button>
                            <button onClick={() => setReschedOpp(null)} className="w-full py-2 text-brand-muted font-bold text-xs uppercase tracking-widest">
                                Cancelar
                            </button>
                        </div>
                        <p className="text-[10px] text-brand-muted text-center mt-3">
                            "Reenviar ao grupo" reabre a vaga para qualquer professor reaceitar. "Manter o mesmo professor" só remarca a data/hora.
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
