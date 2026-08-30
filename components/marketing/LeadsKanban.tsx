import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { MoreHorizontal, Phone, Mail, User, Clock, CheckCircle, XCircle, Plus, Calendar, ArrowRight, X, RefreshCw, ThermometerSun, ThermometerSnowflake, Flame } from 'lucide-react';
import { User as UserType } from '../../types';
import { calculateEnrollmentProRataPreview, dateInSaoPaulo } from '../../lib/enrollmentOffer';
import { normalizeEnrollmentProRataTerms } from '../../lib/enrollment';
import EnrollmentProRataSwitch from '../EnrollmentProRataSwitch';

interface Lead {
    id: string;
    name: string;
    email: string;
    phone: string;
    status: 'NEW' | 'CONTACTED' | 'SCHEDULED' | 'TRIAL_DONE' | 'WON' | 'LOST';
    created_at: string;
    notes?: string;
    scheduled_at?: string;
}

interface LeadsKanbanProps {
    tenantId: string;
}

const ENROLLMENT_WEEKDAYS = [
    { value: 'Monday', label: 'Segunda' },
    { value: 'Tuesday', label: 'Terça' },
    { value: 'Wednesday', label: 'Quarta' },
    { value: 'Thursday', label: 'Quinta' },
    { value: 'Friday', label: 'Sexta' },
    { value: 'Saturday', label: 'Sábado' },
    { value: 'Sunday', label: 'Domingo' },
];

const nextBillingMonthInSaoPaulo = () => {
    const [year, month] = dateInSaoPaulo().split('-').map(Number);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
};

const initialConversionData = () => ({
    planId: '',
    teacherId: '',
    startDate: dateInSaoPaulo(),
    billingStartMonth: nextBillingMonthInSaoPaulo(),
    dueDay: 10,
    enableProRata: false,
    schedule: [] as Array<{ day: string; time: string }>,
});

const LeadsKanban: React.FC<LeadsKanbanProps> = ({ tenantId }) => {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);
    const [teachers, setTeachers] = useState<any[]>([]);

    // Scheduling State
    const [schedulingLead, setSchedulingLead] = useState<Lead | null>(null);
    const [scheduleData, setScheduleData] = useState({
        date: '',
        time: '',
        teacherId: ''
    });
    const [isScheduling, setIsScheduling] = useState(false);

    // Plans State
    const [plans, setPlans] = useState<any[]>([]);

    // Conversion State
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [conversionData, setConversionData] = useState(initialConversionData);
    const [isConverting, setIsConverting] = useState(false);
    const selectedConversionPlan = useMemo(
        () => plans.find(plan => plan.id === conversionData.planId) || null,
        [plans, conversionData.planId],
    );
    const conversionProRataAvailable = Boolean(
        selectedConversionPlan && Number(selectedConversionPlan.fidelity_months) !== 0,
    );
    const conversionProRataEnabled = normalizeEnrollmentProRataTerms({
        enableProRata: conversionData.enableProRata,
        planDuration: selectedConversionPlan?.fidelity_months,
    }).enabled;
    const conversionProRataPreview = useMemo(() => calculateEnrollmentProRataPreview({
        enabled: conversionProRataEnabled,
        monthlyFee: Number(selectedConversionPlan?.monthly_price || 0),
        classesPerWeek: Number(selectedConversionPlan?.classes_per_week || 0),
        dueDay: conversionData.dueDay,
        billingStartMonth: conversionData.billingStartMonth,
        startDate: conversionData.startDate,
        schedule: conversionData.schedule,
    }), [selectedConversionPlan, conversionData, conversionProRataEnabled]);

    const fetchLeads = async () => {
        try {
            const { data, error } = await supabase
                .from('crm_leads')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setLeads(data || []);
        } catch (error) {
            console.error('Error fetching leads:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchTeachers = async () => {
        const { data } = await supabase
            .from('profiles')
            .select('id, full_name')
            .eq('tenant_id', tenantId)
            .eq('role', 'TEACHER')
            .eq('lifecycle_status', 'active');
        setTeachers(data || []);
    };

    const fetchPlans = async () => {
        const { data } = await supabase
            .from('student_pricing_plans')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('active', true);
        setPlans(data || []);
    };

    useEffect(() => {
        fetchLeads();
        fetchTeachers();
        fetchPlans();
    }, [tenantId]);

    const updateStatus = async (id: string, newStatus: Lead['status']) => {
        if (newStatus === 'SCHEDULED') {
            const lead = leads.find(l => l.id === id);
            if (lead) setSchedulingLead(lead);
            return;
        }

        if (newStatus === 'WON') {
            const lead = leads.find(l => l.id === id);
            if (lead) {
                setConversionData(initialConversionData());
                setConvertingLead(lead);
            }
            return;
        }

        // Optimistic update
        setLeads(leads.map(l => l.id === id ? { ...l, status: newStatus } : l));

        const { error } = await supabase
            .from('crm_leads')
            .update({ status: newStatus })
            .eq('id', id);

        if (error) {
            console.error('Error updating status:', error);
            fetchLeads(); // Revert on error
        }
    };

    const handleConfirmSchedule = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!schedulingLead || !scheduleData.date || !scheduleData.time || !scheduleData.teacherId) return;

        setIsScheduling(true);
        try {
            // 1. Create Provisional Profile (TRIAL)
            // Check if profile exists first to avoid duplicates
            const { data: existingProfile } = await supabase
                .from('profiles')
                .select('id')
                .eq('email', schedulingLead.email)
                .single();

            let studentId = existingProfile?.id;

            if (!studentId) {
                const { data: newProfile, error: profileError } = await supabase
                    .from('profiles')
                    .insert({
                        tenant_id: tenantId,
                        email: schedulingLead.email || `lead_${schedulingLead.id}@temp.com`,
                        full_name: schedulingLead.name,
                        role: 'STUDENT',
                        status: 'TRIAL',
                        phone: schedulingLead.phone
                    })
                    .select()
                    .single();

                if (profileError) throw profileError;
                studentId = newProfile.id;
            }

            // 2. Create One-time Class (Reschedule)
            const { error: scheduleError } = await supabase
                .from('reschedules')
                .insert({
                    tenant_id: tenantId,
                    student_id: studentId,
                    teacher_id: scheduleData.teacherId,
                    date: scheduleData.date,
                    time: scheduleData.time,
                    created_by_fault: 'SCHOOL_ADMIN' // abusing column or just ignore
                });

            if (scheduleError) throw scheduleError;

            // 3. Update Lead Status
            const scheduledAt = new Date(`${scheduleData.date}T${scheduleData.time}`).toISOString();
            await supabase
                .from('crm_leads')
                .update({
                    status: 'SCHEDULED',
                    scheduled_at: scheduledAt
                })
                .eq('id', schedulingLead.id);

            // Success
            setSchedulingLead(null);
            setScheduleData({ date: '', time: '', teacherId: '' });
            fetchLeads();
            alert("Aula Experimental Agendada com Sucesso!");

        } catch (error: any) {
            console.error('Scheduling error:', error);
            alert('Erro ao agendar: ' + error.message);
        } finally {
            setIsScheduling(false);
        }
    };

    const handleConfirmConversion = async (e: React.FormEvent) => {
        e.preventDefault();
        const selectedPlan = selectedConversionPlan;
        const expectedFrequency = Number(selectedPlan?.classes_per_week || 0);
        if (!convertingLead || !selectedPlan) {
            alert('Selecione um plano.');
            return;
        }
        if (!conversionData.teacherId) {
            alert('Selecione o professor da grade.');
            return;
        }
        if (
            conversionData.schedule.length !== expectedFrequency ||
            conversionData.schedule.some(slot => !slot.day || !/^\d{2}:\d{2}$/.test(slot.time))
        ) {
            alert(`Preencha exatamente ${expectedFrequency} horários para este plano.`);
            return;
        }
        const scheduleKeys = conversionData.schedule.map(slot => `${slot.day}|${slot.time}`);
        if (new Set(scheduleKeys).size !== scheduleKeys.length) {
            alert('A grade contém um horário repetido.');
            return;
        }
        setIsConverting(true);
        try {
            const { data, error } = await supabase.functions.invoke('school-admin', {
                body: {
                    action: 'createEnrollmentOffer',
                    leadId: convertingLead.id,
                    planId: conversionData.planId,
                    teacherId: conversionData.teacherId,
                    schedule: conversionData.schedule,
                    startDate: conversionData.startDate,
                    billingStartMonth: conversionData.billingStartMonth,
                    dueDay: conversionData.dueDay,
                    enableProRata: conversionProRataEnabled,
                }
            });
            if (error || !data?.ok || typeof data.enrollmentUrl !== 'string') {
                let responseMessage = typeof data?.error === 'string' ? data.error : '';
                const context = (error as any)?.context;
                if (!responseMessage && context && typeof context.clone === 'function') {
                    try {
                        const payload = await context.clone().json();
                        responseMessage = typeof payload?.error === 'string' ? payload.error : '';
                    } catch {
                        responseMessage = '';
                    }
                }
                throw new Error(responseMessage || error?.message || 'Falha ao gerar a oferta segura');
            }

            let copied = false;
            try {
                await navigator.clipboard.writeText(data.enrollmentUrl);
                copied = true;
            } catch {
                copied = false;
            }
            setConvertingLead(null);
            setConversionData(initialConversionData());
            alert(copied
                ? 'Link seguro de matrícula criado e copiado. A matrícula será efetivada somente após o aluno concluir o fluxo.'
                : `Link seguro de matrícula criado:\n\n${data.enrollmentUrl}`);

        } catch (error: any) {
            console.error('Conversion error:', error);
            alert('Erro ao gerar matrícula: ' + error.message);
        } finally {
            setIsConverting(false);
        }
    };

    const getLeadTemperature = (lead: Lead) => {
        const now = new Date();

        // COLD: Scheduled but passed (> 4 hours ago to be safe - missed class)
        if (lead.status === 'SCHEDULED' && lead.scheduled_at) {
            const scheduleDate = new Date(lead.scheduled_at);
            if (now.getTime() - scheduleDate.getTime() > 4 * 60 * 60 * 1000) {
                return { color: 'text-blue-500 bg-blue-50 border-blue-100', icon: ThermometerSnowflake, label: 'Frio (No-Show)' };
            }
        }

        // HOT: Status NEW
        if (lead.status === 'NEW') {
            return { color: 'text-red-500 bg-red-50 border-red-100', icon: Flame, label: 'Quente' };
        }

        // WARM: Contacted
        if (lead.status === 'CONTACTED') {
            return { color: 'text-orange-500 bg-orange-50 border-orange-100', icon: ThermometerSun, label: 'Morno' };
        }

        return null;
    };

    const columns: { id: Lead['status']; label: string; color: string; count: number }[] = [
        { id: 'NEW', label: 'NOVOS LEADS', color: 'bg-blue-500', count: leads.filter(l => l.status === 'NEW').length },
        { id: 'CONTACTED', label: 'AGENDAMENTO EM ABERTO', color: 'bg-yellow-500', count: leads.filter(l => l.status === 'CONTACTED').length },
        { id: 'SCHEDULED', label: 'AULA EXPERIMENTAL', color: 'bg-purple-500', count: leads.filter(l => l.status === 'SCHEDULED').length },
        { id: 'TRIAL_DONE', label: 'PÓS-AULA (FEEDBACK)', color: 'bg-orange-500', count: leads.filter(l => l.status === 'TRIAL_DONE').length },
        { id: 'WON', label: 'MATRICULADOS', color: 'bg-green-500', count: leads.filter(l => l.status === 'WON').length },
        { id: 'LOST', label: 'PERDIDOS', color: 'bg-red-500', count: leads.filter(l => l.status === 'LOST').length },
    ];

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px] text-brand-muted gap-2">
            <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
            <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.1s]" />
            <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.2s]" />
        </div>
    );

    return (
        <>
            <div className="flex overflow-x-auto pb-6 gap-6 min-h-[calc(100vh-200px)]">
                {columns.map(col => (
                    <div key={col.id} className="min-w-[320px] flex-1 flex flex-col">
                        {/* Column Header */}
                        <div className="bg-brand-surface p-4 rounded-t-[24px] border-b border-slate-50 dark:border-brand-border shadow-sm flex justify-between items-center sticky top-0 z-10">
                            <div className="flex items-center gap-3">
                                <div className={`w-3 h-3 rounded-full ${col.color} shadow-[0_0_8px_currentColor] opacity-80`} />
                                <h3 className="font-black text-xs uppercase tracking-widest text-brand-text dark:text-slate-200">
                                    {col.label}
                                </h3>
                            </div>
                            <span className="bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted dark:text-brand-muted px-2.5 py-1 rounded-lg text-xs font-bold">
                                {col.count}
                            </span>
                        </div>

                        {/* Column Body */}
                        <div className="bg-brand-surface-2/50 dark:bg-brand-surface/50 flex-1 p-3 rounded-b-[24px] space-y-3">
                            {leads.filter(l => l.status === col.id).map((lead, index) => (
                                <div
                                    key={lead.id}
                                    className="group bg-brand-surface dark:bg-brand-surface-2 p-5 rounded-2xl shadow-[0px_2px_8px_rgba(0,0,0,0.02)] border border-brand-border dark:border-brand-border/50 hover:shadow-lg hover:-translate-y-1 transition-all duration-300 cursor-grab active:cursor-grabbing relative overflow-hidden"
                                >
                                    {/* Drag Handle / Decorative Top */}
                                    <div className={`absolute top-0 left-0 w-full h-1 ${col.color} opacity-0 group-hover:opacity-100 transition-opacity`} />

                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            {(() => {
                                                const temp = getLeadTemperature(lead);
                                                if (temp) return (
                                                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase mb-1 border ${temp.color}`}>
                                                        <temp.icon size={10} /> {temp.label}
                                                    </div>
                                                );
                                            })()}
                                            <h4 className="font-bold text-base text-brand-text dark:text-slate-100 leading-tight">
                                                {lead.name}
                                            </h4>
                                        </div>
                                        <button className="text-slate-300 hover:text-brand-muted transition-colors">
                                            <MoreHorizontal size={16} />
                                        </button>
                                    </div>

                                    <div className="space-y-2 mb-4">
                                        {lead.email && (
                                            <div className="flex items-center gap-2 text-xs text-brand-muted">
                                                <Mail size={12} className="shrink-0" />
                                                <span className="truncate">{lead.email}</span>
                                            </div>
                                        )}
                                        {lead.phone && (
                                            <div className="flex items-center gap-2 text-xs text-brand-muted">
                                                <Phone size={12} className="shrink-0" />
                                                <span className="truncate">{lead.phone}</span>
                                            </div>
                                        )}
                                        {lead.scheduled_at && (
                                            <div className="flex items-center gap-2 text-[10px] uppercase font-bold text-purple-600 bg-purple-50 px-2 py-1 rounded border border-purple-100 mt-2">
                                                <Clock size={10} />
                                                {new Date(lead.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 text-[10px] uppercase font-bold text-brand-muted mt-2">
                                            <Calendar size={10} />
                                            {new Date(lead.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                                        </div>
                                    </div>

                                    {/* Quick Actions */}
                                    <div className="flex items-center justify-between pt-3 border-t border-slate-50 dark:border-brand-border/50">
                                        {col.id === 'NEW' ? (
                                            <button
                                                onClick={() => updateStatus(lead.id, 'CONTACTED')}
                                                className="flex items-center gap-2 text-xs font-bold text-blue-600 hover:text-blue-700 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors w-full justify-center"
                                            >
                                                Iniciar Contato <ArrowRight size={12} />
                                            </button>
                                        ) : col.id === 'CONTACTED' ? (
                                            <div className="flex gap-2 w-full">
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'SCHEDULED')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-lg text-xs font-bold hover:bg-purple-100 transition-colors"
                                                >
                                                    <Calendar size={12} /> Agendar
                                                </button>
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'LOST')}
                                                    className="px-2 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors"
                                                    title="Perder"
                                                >
                                                    <XCircle size={12} />
                                                </button>
                                            </div>
                                        ) : col.id === 'SCHEDULED' ? (
                                            <div className="flex gap-2 w-full">
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'TRIAL_DONE')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-lg text-xs font-bold hover:bg-orange-100 transition-colors"
                                                >
                                                    <CheckCircle size={12} /> Concluir Aula
                                                </button>
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'LOST')}
                                                    className="px-2 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors"
                                                >
                                                    <XCircle size={12} />
                                                </button>
                                            </div>
                                        ) : col.id === 'TRIAL_DONE' ? (
                                            <div className="flex gap-2 w-full">
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'WON')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg text-xs font-bold hover:bg-green-100 transition-colors"
                                                >
                                                    <CheckCircle size={12} /> Matricular
                                                </button>
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'LOST')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors"
                                                >
                                                    <XCircle size={12} /> Perder
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex gap-2 w-full">
                                                {/* Actions for Converted/Lost if any - usually none or 'Reactivate' */}
                                                {col.id === 'LOST' && (
                                                    <button
                                                        onClick={() => updateStatus(lead.id, 'NEW')}
                                                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-brand-surface-2 text-brand-muted dark:text-brand-muted rounded-lg text-xs font-bold hover:bg-brand-surface-2 transition-colors"
                                                    >
                                                        <RefreshCw size={12} /> Reativar
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}

                            {/* Empty State / Add Placeholder */}
                            {col.id === 'NEW' && (
                                <button className="w-full py-3 border-2 border-dashed border-brand-border rounded-xl text-brand-muted hover:text-brand-muted hover:border-brand-border dark:hover:text-slate-300 transition-all flex items-center justify-center gap-2 text-xs font-bold group">
                                    <span className="bg-brand-surface-2 dark:bg-brand-surface-2 p-1 rounded-full group-hover:scale-110 transition-transform">
                                        <Plus size={14} />
                                    </span>
                                    Adicionar Manualmente
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Schedule Modal */}
            {schedulingLead && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-300">
                    <div className="bg-brand-surface rounded-3xl shadow-2xl p-8 max-w-md w-full relative">
                        <button
                            onClick={() => setSchedulingLead(null)}
                            className="absolute top-6 right-6 text-brand-muted hover:text-brand-muted"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h3 className="text-2xl font-black text-brand-text">Agendar Aula Experimental</h3>
                            <p className="text-brand-muted mt-1">Defina o horário para {schedulingLead.name}.</p>
                        </div>

                        <form onSubmit={handleConfirmSchedule} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Data</label>
                                <input
                                    type="date"
                                    required
                                    className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    value={scheduleData.date}
                                    onChange={e => setScheduleData({ ...scheduleData, date: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Horário</label>
                                <input
                                    type="time"
                                    required
                                    className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    value={scheduleData.time}
                                    onChange={e => setScheduleData({ ...scheduleData, time: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Professor</label>
                                <select
                                    required
                                    className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    value={scheduleData.teacherId}
                                    onChange={e => setScheduleData({ ...scheduleData, teacherId: e.target.value })}
                                >
                                    <option value="">Selecione um professor...</option>
                                    {teachers.map(t => (
                                        <option key={t.id} value={t.id}>{t.full_name}</option>
                                    ))}
                                </select>
                            </div>

                            <button
                                type="submit"
                                disabled={isScheduling}
                                className="w-full py-4 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl shadow-lg shadow-purple-500/20 transition-all flex items-center justify-center gap-2 mt-4"
                            >
                                {isScheduling ? <RefreshCw className="animate-spin" /> : <Calendar />}
                                CONFIRMAR AGENDAMENTO
                            </button>
                        </form>
                    </div>
                </div>
            )}
            {/* Conversion Modal */}
            {convertingLead && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-300">
                    <div className="bg-brand-surface rounded-3xl shadow-2xl p-8 max-w-3xl max-h-[92vh] overflow-y-auto w-full relative">
                        <button
                            onClick={() => setConvertingLead(null)}
                            className="absolute top-6 right-6 text-brand-muted hover:text-brand-muted"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h3 className="text-2xl font-black text-brand-text">Gerar Matrícula Segura</h3>
                            <p className="text-brand-muted mt-1">Crie uma oferta protegida para {convertingLead.name} concluir.</p>
                        </div>

                        <form onSubmit={handleConfirmConversion} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Plano Selecionado</label>
                                <div className="grid grid-cols-2 gap-3">
                                    {plans.map(plan => (
                                        <button
                                            key={plan.id}
                                            type="button"
                                            onClick={() => {
                                                const frequency = Number(plan.classes_per_week || 0);
                                                setConversionData(current => ({
                                                    ...current,
                                                    planId: plan.id,
                                                    enableProRata: Number(plan.fidelity_months) !== 0
                                                        ? current.enableProRata
                                                        : false,
                                                    schedule: Array.from({ length: frequency }, (_, index) =>
                                                        current.schedule[index] || { day: '', time: '' }
                                                    ),
                                                }));
                                            }}
                                            className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${conversionData.planId === plan.id
                                                ? 'border-purple-500 bg-purple-50 text-purple-700'
                                                : 'border-brand-border text-brand-muted hover:border-brand-border'
                                                }`}
                                        >
                                            {plan.name}
                                            <div className="text-[10px] opacity-70 mt-1">
                                                R$ {plan.monthly_price}/mês
                                            </div>
                                        </button>
                                    ))}
                                    {plans.length === 0 && (
                                        <div className="col-span-2 text-center text-xs text-brand-muted py-4 border border-dashed rounded-xl">
                                            Nenhum plano ativo encontrado.
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Professor da grade</label>
                                    <select
                                        required
                                        value={conversionData.teacherId}
                                        onChange={event => setConversionData(current => ({
                                            ...current,
                                            teacherId: event.target.value,
                                        }))}
                                        className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    >
                                        <option value="">Selecione um professor...</option>
                                        {teachers.map(teacher => (
                                            <option key={teacher.id} value={teacher.id}>{teacher.full_name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Início das aulas</label>
                                    <input
                                        type="date"
                                        required
                                        min={dateInSaoPaulo()}
                                        value={conversionData.startDate}
                                        onChange={event => setConversionData(current => ({
                                            ...current,
                                            startDate: event.target.value,
                                        }))}
                                        className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Primeiro mês de cobrança</label>
                                    <input
                                        type="month"
                                        required
                                        min={dateInSaoPaulo().slice(0, 7)}
                                        value={conversionData.billingStartMonth}
                                        onChange={event => setConversionData(current => ({
                                            ...current,
                                            billingStartMonth: event.target.value,
                                        }))}
                                        className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Dia do vencimento</label>
                                    <select
                                        value={conversionData.dueDay}
                                        onChange={event => setConversionData(current => ({
                                            ...current,
                                            dueDay: Number(event.target.value),
                                        }))}
                                        className="w-full p-3 bg-brand-surface-2 border border-brand-border rounded-xl font-bold text-brand-text"
                                    >
                                        {Array.from({ length: 31 }, (_, index) => index + 1).map(day => (
                                            <option key={day} value={day}>Dia {day}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            {conversionData.schedule.length > 0 && (
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted mb-2 block">Grade semanal</label>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {conversionData.schedule.map((slot, index) => (
                                            <div key={index} className="grid grid-cols-2 gap-2 rounded-xl border border-brand-border bg-brand-surface-2 p-3">
                                                <select
                                                    aria-label={`Dia da aula ${index + 1}`}
                                                    required
                                                    value={slot.day}
                                                    onChange={event => setConversionData(current => ({
                                                        ...current,
                                                        schedule: current.schedule.map((item, itemIndex) =>
                                                            itemIndex === index ? { ...item, day: event.target.value } : item
                                                        ),
                                                    }))}
                                                    className="bg-transparent text-sm font-bold text-brand-text outline-none"
                                                >
                                                    <option value="">Dia</option>
                                                    {ENROLLMENT_WEEKDAYS.map(day => (
                                                        <option key={day.value} value={day.value}>{day.label}</option>
                                                    ))}
                                                </select>
                                                <input
                                                    aria-label={`Hora da aula ${index + 1}`}
                                                    type="time"
                                                    required
                                                    value={slot.time}
                                                    onChange={event => setConversionData(current => ({
                                                        ...current,
                                                        schedule: current.schedule.map((item, itemIndex) =>
                                                            itemIndex === index ? { ...item, time: event.target.value } : item
                                                        ),
                                                    }))}
                                                    className="bg-transparent text-sm font-bold text-brand-text outline-none"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                    <p className="mt-2 text-[11px] text-brand-muted">
                                        O servidor confirma a disponibilidade do professor antes de criar o link.
                                    </p>
                                </div>
                            )}

                            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                                <EnrollmentProRataSwitch
                                    checked={conversionProRataEnabled}
                                    disabled={!conversionProRataAvailable}
                                    label="Cobrar pró-rata nesta matrícula"
                                    onCheckedChange={checked => setConversionData(current => ({
                                        ...current,
                                        enableProRata: checked,
                                    }))}
                                />
                                <span>
                                    <strong className="block">Cobrar pró-rata</strong>
                                    {!selectedConversionPlan
                                        ? 'Selecione um plano para configurar.'
                                        : !conversionProRataAvailable
                                            ? 'Não se aplica ao plano de aula avulsa.'
                                            : conversionProRataEnabled
                                                ? 'Ativado: o valor proporcional será recalculado no servidor pela grade escolhida.'
                                                : 'Desativado: não haverá cobrança proporcional antes da primeira mensalidade.'}
                                    {conversionProRataEnabled && conversionProRataPreview.classCount > 0 && (
                                        <small className="mt-1 block font-bold">
                                            R$ {conversionProRataPreview.pricePerClass.toFixed(2)} × {conversionProRataPreview.classCount} aulas = R$ {conversionProRataPreview.value.toFixed(2)}
                                        </small>
                                    )}
                                </span>
                            </div>

                            <div className="bg-brand-surface-2 p-4 rounded-xl border border-brand-border text-xs text-brand-muted">
                                <p className="font-bold mb-1">Fluxo protegido:</p>
                                <ul className="list-disc pl-4 space-y-1">
                                    <li>Preço e plano validados no servidor</li>
                                    <li>Professor e horários revalidados antes do link</li>
                                    <li>Pró-rata opcional, recalculado no servidor quando ativado</li>
                                    <li>Link vinculado ao tenant ativo</li>
                                    <li>Acesso liberado somente após a conclusão</li>
                                </ul>
                            </div>

                            <button
                                type="submit"
                                disabled={isConverting}
                                className="w-full py-4 bg-green-500 hover:bg-green-600 text-white font-black rounded-xl shadow-lg shadow-green-500/20 transition-all flex items-center justify-center gap-2 mt-4"
                            >
                                {isConverting ? <RefreshCw className="animate-spin" /> : <CheckCircle />}
                                GERAR LINK DE MATRÍCULA
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
};

export default LeadsKanban;
