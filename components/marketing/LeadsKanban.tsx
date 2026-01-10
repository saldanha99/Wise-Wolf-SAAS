import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { MoreHorizontal, Phone, Mail, User, Clock, CheckCircle, XCircle, Plus, Calendar, ArrowRight } from 'lucide-react';

interface Lead {
    id: string;
    name: string;
    email: string;
    phone: string;
    status: 'NEW' | 'CONTACTED' | 'CONVERTED' | 'LOST';
    created_at: string;
    notes?: string;
}

interface LeadsKanbanProps {
    tenantId: string;
}

const LeadsKanban: React.FC<LeadsKanbanProps> = ({ tenantId }) => {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);

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

    useEffect(() => {
        fetchLeads();
    }, [tenantId]);

    const updateStatus = async (id: string, newStatus: Lead['status']) => {
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

    const columns: { id: Lead['status']; label: string; color: string; count: number }[] = [
        { id: 'NEW', label: 'NOVOS LEADS', color: 'bg-blue-500', count: leads.filter(l => l.status === 'NEW').length },
        { id: 'CONTACTED', label: 'EM CONTATO', color: 'bg-yellow-500', count: leads.filter(l => l.status === 'CONTACTED').length },
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
                                    <h4 className="font-bold text-base text-slate-800 dark:text-slate-100 leading-tight">
                                        {lead.name}
                                    </h4>
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
                                    ) : (
                                        <div className="flex gap-2 w-full">
                                            {col.id !== 'CONVERTED' && (
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'CONVERTED')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg text-xs font-bold hover:bg-green-100 transition-colors"
                                                    title="Matricular"
                                                >
                                                    <CheckCircle size={12} /> Matricular
                                                </button>
                                            )}
                                            {col.id !== 'LOST' && col.id !== 'CONVERTED' && (
                                                <button
                                                    onClick={() => updateStatus(lead.id, 'LOST')}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors"
                                                    title="Marcar como Perdido"
                                                >
                                                    <XCircle size={12} /> Perder
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
    );
};

export default LeadsKanban;
