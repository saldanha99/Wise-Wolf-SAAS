import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { MoreHorizontal, Phone, Mail, User, Clock, CheckCircle, XCircle, Plus, Calendar, ArrowRight, X, RefreshCw, ThermometerSun, ThermometerSnowflake, Flame } from 'lucide-react';
import { User as UserType } from '../../types';

interface Lead {
    id: string;
    name: string;
    email: string;
    phone: string;
    status: 'NEW' | 'CONTACTED' | 'SCHEDULED' | 'TRIAL_DONE' | 'CONVERTED' | 'LOST';
    created_at: string;
    notes?: string;
    scheduled_at?: string;
}

interface LeadsKanbanProps {
    tenantId: string;
}

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
    const [conversionData, setConversionData] = useState({
        planId: '',
        paymentMethod: 'credit_card'
    });
    const [isConverting, setIsConverting] = useState(false);

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
            .eq('role', 'TEACHER');
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

        if (newStatus === 'CONVERTED') {
            const lead = leads.find(l => l.id === id);
            if (lead) setConvertingLead(lead);
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
        if (!convertingLead || !conversionData.planId) {
            alert("Selecione um plano.");
            return;
        }
        setIsConverting(true);
        try {
            const response = await fetch('/api/enroll-student', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    leadId: convertingLead.id,
                    planId: conversionData.planId,
                    tenantId
                })
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Falha na conversão');

            console.log("Conversion Success:", result);
            setConvertingLead(null);
            fetchLeads();
            alert("Matrícula efetivada com sucesso! Cliente e Assinatura criados.");

        } catch (error: any) {
            console.error('Conversion error:', error);
            alert('Erro ao converter: ' + error.message);
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
        { id: 'CONVERTED', label: 'MATRICULADOS', color: 'bg-green-500', count: leads.filter(l => l.status === 'CONVERTED').length },
        { id: 'LOST', label: 'PERDIDOS', color: 'bg-red-500', count: leads.filter(l => l.status === 'LOST').length },
    ];

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px] text-slate-400 gap-2">
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
                        <div className="bg-white dark:bg-slate-900 p-4 rounded-t-[24px] border-b border-slate-50 dark:border-slate-800 shadow-sm flex justify-between items-center sticky top-0 z-10">
                            <div className="flex items-center gap-3">
                                <div className={`w-3 h-3 rounded-full ${col.color} shadow-[0_0_8px_currentColor] opacity-80`} />
                                <h3 className="font-black text-xs uppercase tracking-widest text-slate-700 dark:text-slate-200">
                                    {col.label}
                                </h3>
                            </div>
                            <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2.5 py-1 rounded-lg text-xs font-bold">
                                {col.count}
                            </span>
                        </div>

                        {/* Column Body */}
                        <div className="bg-slate-50/50 dark:bg-slate-900/50 flex-1 p-3 rounded-b-[24px] space-y-3">
                            {leads.filter(l => l.status === col.id).map((lead, index) => (
                                <div
                                    key={lead.id}
                                    className="group bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-[0px_2px_8px_rgba(0,0,0,0.02)] border border-slate-100 dark:border-slate-700/50 hover:shadow-lg hover:-translate-y-1 transition-all duration-300 cursor-grab active:cursor-grabbing relative overflow-hidden"
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
                                            <h4 className="font-bold text-base text-slate-800 dark:text-slate-100 leading-tight">
                                                {lead.name}
                                            </h4>
                                        </div>
                                        <button className="text-slate-300 hover:text-slate-500 transition-colors">
                                            <MoreHorizontal size={16} />
                                        </button>
                                    </div>

                                    <div className="space-y-2 mb-4">
                                        {lead.email && (
                                            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                                <Mail size={12} className="shrink-0" />
                                                <span className="truncate">{lead.email}</span>
                                            </div>
                                        )}
                                        {lead.phone && (
                                            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
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
                                        <div className="flex items-center gap-2 text-[10px] uppercase font-bold text-slate-400 mt-2">
                                            <Calendar size={10} />
                                            {new Date(lead.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                                        </div>
                                    </div>

                                    {/* Quick Actions */}
                                    <div className="flex items-center justify-between pt-3 border-t border-slate-50 dark:border-slate-700/50">
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
                                                    onClick={() => updateStatus(lead.id, 'CONVERTED')}
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
                                                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg text-xs font-bold hover:bg-slate-100 transition-colors"
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
                                <button className="w-full py-3 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-slate-400 hover:text-slate-600 hover:border-slate-300 dark:hover:text-slate-300 transition-all flex items-center justify-center gap-2 text-xs font-bold group">
                                    <span className="bg-slate-100 dark:bg-slate-800 p-1 rounded-full group-hover:scale-110 transition-transform">
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
                    <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-8 max-w-md w-full relative">
                        <button
                            onClick={() => setSchedulingLead(null)}
                            className="absolute top-6 right-6 text-slate-400 hover:text-slate-600"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h3 className="text-2xl font-black text-slate-800 dark:text-white">Agendar Aula Experimental</h3>
                            <p className="text-slate-500 mt-1">Defina o horário para {schedulingLead.name}.</p>
                        </div>

                        <form onSubmit={handleConfirmSchedule} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500 mb-1 block">Data</label>
                                <input
                                    type="date"
                                    required
                                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-700"
                                    value={scheduleData.date}
                                    onChange={e => setScheduleData({ ...scheduleData, date: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500 mb-1 block">Horário</label>
                                <input
                                    type="time"
                                    required
                                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-700"
                                    value={scheduleData.time}
                                    onChange={e => setScheduleData({ ...scheduleData, time: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500 mb-1 block">Professor</label>
                                <select
                                    required
                                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-700"
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
                    <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-8 max-w-md w-full relative">
                        <button
                            onClick={() => setConvertingLead(null)}
                            className="absolute top-6 right-6 text-slate-400 hover:text-slate-600"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h3 className="text-2xl font-black text-slate-800 dark:text-white">Efetivar Matrícula</h3>
                            <p className="text-slate-500 mt-1">Transforme {convertingLead.name} em aluno.</p>
                        </div>

                        <form onSubmit={handleConfirmConversion} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500 mb-1 block">Plano Selecionado</label>
                                <div className="grid grid-cols-2 gap-3">
                                    {plans.map(plan => (
                                        <button
                                            key={plan.id}
                                            type="button"
                                            onClick={() => setConversionData({ ...conversionData, planId: plan.id })}
                                            className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${conversionData.planId === plan.id
                                                ? 'border-purple-500 bg-purple-50 text-purple-700'
                                                : 'border-slate-100 text-slate-500 hover:border-slate-200'
                                                }`}
                                        >
                                            {plan.name}
                                            <div className="text-[10px] opacity-70 mt-1">
                                                R$ {plan.monthly_price}/mês
                                            </div>
                                        </button>
                                    ))}
                                    {plans.length === 0 && (
                                        <div className="col-span-2 text-center text-xs text-slate-400 py-4 border border-dashed rounded-xl">
                                            Nenhum plano ativo encontrado.
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-xs text-slate-500">
                                <p className="font-bold mb-1">Ações Automáticas:</p>
                                <ul className="list-disc pl-4 space-y-1">
                                    <li>Cobrança Asaas gerada</li>
                                    <li>Acesso à plataforma liberado</li>
                                    <li>Role atualizada para STUDENT</li>
                                </ul>
                            </div>

                            <button
                                type="submit"
                                disabled={isConverting}
                                className="w-full py-4 bg-green-500 hover:bg-green-600 text-white font-black rounded-xl shadow-lg shadow-green-500/20 transition-all flex items-center justify-center gap-2 mt-4"
                            >
                                {isConverting ? <RefreshCw className="animate-spin" /> : <CheckCircle />}
                                CONFIRMAR MATRÍCULA
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
};

export default LeadsKanban;
