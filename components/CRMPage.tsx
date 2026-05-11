import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import {
    Kanban, User, Phone, Mail, MessageCircle, Search, Filter, Plus,
    CheckCircle, X, ChevronRight, Share2, Copy, Calendar, AlertCircle,
    Clock, DollarSign, MoreHorizontal, Edit2
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface CRMPageProps {
    tenantId: string;
}

interface Lead {
    id: string;
    name: string;
    email: string;
    phone: string;
    status: 'NEW' | 'CONTACTED' | 'TRIAL' | 'WON' | 'LOST';
    source: string;
    notes: string;
    created_at: string;
    student_id?: string;
    // New Rich UI Fields
    value: number;
    tags: string[];
    last_status_change: string;
}

const CRMPage: React.FC<CRMPageProps> = ({ tenantId }) => {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);
    const [draggedLead, setDraggedLead] = useState<Lead | null>(null);

    // Filter/Search State
    const [searchTerm, setSearchTerm] = useState('');

    const COLUMN_CONFIG = {
        'NEW': { label: 'Novos Leads', color: 'border-blue-500', bg: 'bg-blue-50/50', text: 'text-blue-700', iconColor: 'text-blue-600' },
        'CONTACTED': { label: 'Em Contato', color: 'border-yellow-500', bg: 'bg-yellow-50/50', text: 'text-yellow-700', iconColor: 'text-yellow-600' },
        'TRIAL': { label: 'Aula Agendada', color: 'border-purple-500', bg: 'bg-purple-50/50', text: 'text-purple-700', iconColor: 'text-purple-600' },
        'WON': { label: 'Matriculados', color: 'border-green-500', bg: 'bg-green-50/50', text: 'text-green-700', iconColor: 'text-green-600' }
        // LOST is hidden from main board or put in a separate view usually, but we keep 4 cols as requested
        // If user wants 4 cols, we fit NEW, CONTACTED, TRIAL, WON.
    };

    // We explicitly define the columns we want to show in the Grid
    const VISIBLE_COLUMNS = ['NEW', 'CONTACTED', 'TRIAL', 'WON'] as const;

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

    // --- METRICS CALCULATION ---
    const metrics = useMemo(() => {
        const totalValue = leads.reduce((acc, lead) => acc + (lead.value || 0), 0);
        const wonCount = leads.filter(l => l.status === 'WON').length;
        const totalCount = leads.length;
        const conversionRate = totalCount > 0 ? ((wonCount / totalCount) * 100).toFixed(1) : '0';

        return {
            opportunities: leads.filter(l => l.status !== 'WON' && l.status !== 'LOST').length,
            pipelineValue: totalValue,
            conversion: conversionRate
        };
    }, [leads]);

    const filteredLeads = useMemo(() => {
        return leads.filter(l =>
            l.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            l.email?.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [leads, searchTerm]);

    // --- DRAG HANDLERS ---
    const handleDragStart = (e: React.DragEvent, lead: Lead) => {
        setDraggedLead(lead);
        e.dataTransfer.effectAllowed = 'move';
        // Transparent drag image hack if needed, or default
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = async (e: React.DragEvent, targetStatus: string) => {
        e.preventDefault();
        if (!draggedLead || draggedLead.status === targetStatus) return;

        const newStatus = targetStatus as Lead['status'];
        const now = new Date().toISOString();

        if (newStatus === 'WON') {
            confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }

        // Optimistic Update
        const updatedList = leads.map(l =>
            l.id === draggedLead.id ? { ...l, status: newStatus, last_status_change: now } : l
        );
        setLeads(updatedList);
        setDraggedLead(null); // Reset

        // DB Update
        await supabase.from('crm_leads').update({
            status: newStatus,
            last_status_change: now
        }).eq('id', draggedLead.id);
    };

    // --- HELPER FOR "TIME IN STAGE" ---
    const getDaysInStage = (dateString: string) => {
        if (!dateString) return 0;
        const diff = new Date().getTime() - new Date(dateString).getTime();
        return Math.floor(diff / (1000 * 3600 * 24));
    };

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-900 overflow-hidden">
            {/* 1. TOP BAR / KPI DASHBOARD */}
            <header className="h-[80px] shrink-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-6 flex items-center justify-between z-10">
                <div className="flex items-center gap-6">
                    <h1 className="text-xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
                        <Kanban className="text-blue-600" /> Pipeline de Vendas
                    </h1>

                    {/* Vertical Divider */}
                    <div className="h-8 w-px bg-gray-200 dark:bg-slate-700 mx-2" />

                    {/* KPIs */}
                    <div className="flex gap-8">
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Oportunidades</p>
                            <p className="text-xl font-black text-gray-800 dark:text-white">{metrics.opportunities}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Pipeline Total</p>
                            <p className="text-xl font-black text-emerald-600">
                                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(metrics.pipelineValue)}
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Conversão</p>
                            <p className="text-xl font-black text-blue-600">{metrics.conversion}%</p>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Buscar alunos..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="pl-9 pr-4 py-2 bg-gray-100 dark:bg-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 w-64 transition-all"
                        />
                    </div>
                    <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 shadow-lg shadow-blue-500/20 transition-all">
                        <Plus size={16} /> Nova Oportunidade
                    </button>
                    <button className="p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg">
                        <Filter size={20} />
                    </button>
                </div>
            </header>

            {/* 2. MAIN BOARD - GRID LAYOUT (NO PAGE SCROLL) */}
            <main className="flex-1 p-6 overflow-hidden">
                <div className="grid grid-cols-4 gap-4 h-full">
                    {VISIBLE_COLUMNS.map((status) => {
                        const columnLeads = filteredLeads.filter(l => l.status === status);
                        const colTotalValue = columnLeads.reduce((acc, item) => acc + (item.value || 0), 0);
                        const config = COLUMN_CONFIG[status];

                        return (
                            <div
                                key={status}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, status)}
                                className={`flex flex-col h-full rounded-2xl bg-gray-100/50 dark:bg-slate-800/50 border border-transparent transition-colors ${draggedLead ? 'hover:bg-blue-50/50 hover:border-blue-200 dark:hover:bg-slate-800' : ''}`}
                            >
                                {/* Column Header */}
                                <div className={`p-4 rounded-t-2xl border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex justify-between items-start sticky top-0 z-10 shadow-sm`}>
                                    <div>
                                        <div className={`text-xs font-black uppercase tracking-widest mb-1 ${config.text}`}>
                                            {config.label}
                                        </div>
                                        <div className="text-xs font-medium text-gray-400">
                                            {columnLeads.length} leads • {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact' }).format(colTotalValue)}
                                        </div>
                                    </div>
                                    <div className={`w-2 h-2 rounded-full ${config.text.replace('text-', 'bg-')}`} />
                                </div>

                                {/* Column Scrollable Area */}
                                <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-slate-600">
                                    {columnLeads.map((lead) => {
                                        const daysInStage = getDaysInStage(lead.last_status_change || lead.created_at);
                                        const isStagnant = daysInStage > 3;

                                        return (
                                            <div
                                                key={lead.id}
                                                draggable
                                                onDragStart={(e) => handleDragStart(e, lead)}
                                                className="group bg-white dark:bg-slate-800 p-4 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 hover:shadow-md hover:border-blue-400 dark:hover:border-blue-500 cursor-grab active:cursor-grabbing transition-all relative"
                                            >
                                                {/* Header: Name + Avatar */}
                                                <div className="flex items-start gap-3 mb-3">
                                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900 dark:to-slate-800 flex items-center justify-center text-blue-600 font-bold shrink-0">
                                                        {lead.name[0]}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <h4 className="font-bold text-gray-900 dark:text-white truncate text-sm" title={lead.name}>
                                                            {lead.name}
                                                        </h4>
                                                        <p className="text-xs text-gray-400 truncate">{lead.source}</p>
                                                    </div>
                                                    <button className="text-gray-300 hover:text-gray-600 dark:hover:text-gray-200">
                                                        <MoreHorizontal size={16} />
                                                    </button>
                                                </div>

                                                {/* Details: Value + Tags */}
                                                <div className="flex flex-wrap gap-2 mb-4">
                                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] font-bold uppercase">
                                                        R$ {lead.value || 0}
                                                    </span>
                                                    {lead.tags?.slice(0, 2).map((tag: string, i: number) => (
                                                        <span key={i} className="px-2 py-1 rounded bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-300 text-[10px] font-bold uppercase">
                                                            {tag}
                                                        </span>
                                                    ))}
                                                </div>

                                                {/* Warning: Time in Stage */}
                                                {isStagnant && (
                                                    <div className="flex items-center gap-1.5 mb-3 text-red-500 text-[10px] font-bold bg-red-50 dark:bg-red-900/10 px-2 py-1 rounded w-fit">
                                                        <Clock size={12} />
                                                        {daysInStage} dias nesta etapa
                                                    </div>
                                                )}

                                                {/* Divider */}
                                                <div className="h-px bg-gray-100 dark:bg-slate-700 mb-3" />

                                                {/* Footer Actions */}
                                                <div className="flex items-center justify-between">
                                                    <div className="flex gap-2">
                                                        {lead.phone && (
                                                            <a
                                                                href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="p-1.5 rounded-lg text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
                                                                title="WhatsApp"
                                                            >
                                                                <MessageCircle size={16} />
                                                            </a>
                                                        )}
                                                        <button
                                                            className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                                                            title="Editar"
                                                        >
                                                            <Edit2 size={16} />
                                                        </button>
                                                    </div>
                                                    <span className="text-[10px] text-gray-400 font-medium">
                                                        {new Date(lead.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </main>
        </div>
    );
};

export default CRMPage;
