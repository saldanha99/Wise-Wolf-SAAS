import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, MoreHorizontal, Calendar, CheckCircle, XCircle } from 'lucide-react';

interface SaasLead {
    id: string;
    name: string;
    email: string;
    phone: string;
    school_name: string;
    status: 'LEAD' | 'DEMO_SCHEDULED' | 'TRIAL' | 'CLOSED_WON' | 'CLOSED_LOST';
    notes?: string;
    created_at: string;
}

const COLUMNS = [
    { id: 'LEAD', label: 'Leads (Interessados)', color: 'bg-slate-100 text-slate-600' },
    { id: 'DEMO_SCHEDULED', label: 'Demonstração Agendada', color: 'bg-blue-100 text-blue-600' },
    { id: 'TRIAL', label: 'Trial (7/14 Dias)', color: 'bg-purple-100 text-purple-600' },
    { id: 'CLOSED_WON', label: 'Fechado (Ativo)', color: 'bg-emerald-100 text-emerald-600' }
];

const SaasCrmBoard: React.FC = () => {
    const [leads, setLeads] = useState<SaasLead[]>([]);
    const [loading, setLoading] = useState(true);
    const [showNewLeadModal, setShowNewLeadModal] = useState(false);
    const [newLead, setNewLead] = useState({ name: '', email: '', phone: '', school_name: '', notes: '' });

    useEffect(() => {
        fetchLeads();
    }, []);

    const fetchLeads = async () => {
        try {
            const { data, error } = await supabase
                .from('saas_leads')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setLeads(data || []);
        } catch (error) {
            console.error('Error fetching leads:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateLead = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const { error } = await supabase.from('saas_leads').insert([newLead]);
            if (error) throw error;
            setShowNewLeadModal(false);
            setNewLead({ name: '', email: '', phone: '', school_name: '', notes: '' });
            fetchLeads();
        } catch (error) {
            alert('Erro ao criar lead');
        }
    };

    const handleMoveLead = async (leadId: string, newStatus: string) => {
        try {
            // Optimistic update
            setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus as any } : l));

            const { error } = await supabase
                .from('saas_leads')
                .update({ status: newStatus })
                .eq('id', leadId);

            if (error) throw error;
        } catch (error) {
            console.error('Error updating status:', error);
            fetchLeads(); // Revert on error
        }
    };

    return (
        <div className="h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white">Pipeline de Vendas SaaS</h2>
                    <p className="text-sm text-slate-500">Gestão de prospecção B2B (Escolas)</p>
                </div>
                <button
                    onClick={() => setShowNewLeadModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 shadow-lg hover:shadow-blue-500/20 transition-all"
                >
                    <Plus size={18} /> Novo Lead
                </button>
            </div>

            <div className="flex-1 overflow-x-auto">
                <div className="flex gap-4 h-full min-w-[1000px] pb-4">
                    {COLUMNS.map(col => (
                        <div key={col.id} className="flex-1 min-w-[280px] bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 flex flex-col border border-slate-100 dark:border-slate-800">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className={`font-bold text-sm px-3 py-1 rounded-full ${col.color}`}>{col.label}</h3>
                                <span className="text-xs font-bold text-slate-400">
                                    {leads.filter(l => l.status === col.id).length}
                                </span>
                            </div>

                            <div className="space-y-3 overflow-y-auto flex-1 pr-2">
                                {leads.filter(l => l.status === col.id).map(lead => (
                                    <div key={lead.id} className="bg-white dark:bg-slate-800 p-4 rounded-xl shadow-sm border border-slate-100 dark:border-slate-700 hover:shadow-md transition-all group">
                                        <div className="flex justify-between items-start mb-2">
                                            <span className="font-bold text-slate-800 dark:text-white block">{lead.school_name}</span>
                                            <button className="text-slate-300 hover:text-slate-500"><MoreHorizontal size={14} /></button>
                                        </div>
                                        <p className="text-xs text-slate-500 mb-3">{lead.name}</p>

                                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-medium border-t border-slate-50 dark:border-slate-700 pt-3">
                                            {col.id === 'LEAD' && (
                                                <button onClick={() => handleMoveLead(lead.id, 'DEMO_SCHEDULED')} className="flex items-center gap-1 hover:text-blue-500">
                                                    Agendar Demo <Calendar size={12} />
                                                </button>
                                            )}
                                            {col.id === 'DEMO_SCHEDULED' && (
                                                <button onClick={() => handleMoveLead(lead.id, 'TRIAL')} className="flex items-center gap-1 hover:text-purple-500">
                                                    Iniciar Trial <CheckCircle size={12} />
                                                </button>
                                            )}
                                            {col.id === 'TRIAL' && (
                                                <div className="flex gap-2 w-full">
                                                    <button onClick={() => handleMoveLead(lead.id, 'CLOSED_WON')} className="flex-1 bg-emerald-50 text-emerald-600 py-1 rounded hover:bg-emerald-100 transition-colors text-center">
                                                        Fechar
                                                    </button>
                                                    <button onClick={() => handleMoveLead(lead.id, 'CLOSED_LOST')} className="flex-1 bg-red-50 text-red-600 py-1 rounded hover:bg-red-100 transition-colors text-center">
                                                        Perder
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Modal Logic would go here (Simplified for brevity) */}
            {showNewLeadModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md p-6 rounded-2xl shadow-xl">
                        <h3 className="text-xl font-bold mb-4">Novo Lead SaaS</h3>
                        <form onSubmit={handleCreateLead} className="space-y-4">
                            <input
                                placeholder="Nome da Escola"
                                className="w-full p-3 bg-slate-50 rounded-xl"
                                value={newLead.school_name} onChange={e => setNewLead({ ...newLead, school_name: e.target.value })}
                                required
                            />
                            <input
                                placeholder="Contato Principal"
                                className="w-full p-3 bg-slate-50 rounded-xl"
                                value={newLead.name} onChange={e => setNewLead({ ...newLead, name: e.target.value })}
                                required
                            />
                            <input
                                placeholder="Email"
                                className="w-full p-3 bg-slate-50 rounded-xl"
                                value={newLead.email} onChange={e => setNewLead({ ...newLead, email: e.target.value })}
                            />
                            <div className="flex justify-end gap-2 pt-4">
                                <button type="button" onClick={() => setShowNewLeadModal(false)} className="px-4 py-2 text-slate-500">Cancelar</button>
                                <button type="submit" className="px-6 py-2 bg-blue-600 text-white rounded-xl font-bold">Salvar Lead</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SaasCrmBoard;
