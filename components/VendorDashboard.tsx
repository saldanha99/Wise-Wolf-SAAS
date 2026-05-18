import React, { useState, useEffect } from 'react';
import { TrendingUp, DollarSign, Users, Link, Calendar, Copy, CheckCircle, Clock, Award } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { APP_BASE_URL } from '../constants';

interface VendorDashboardProps {
    user: User;
    tenantId?: string;
    teachers?: any[];
    onNavigate?: (tab: string) => void;
}

interface Commission {
    id: string;
    student_name: string;
    amount_brl: number;
    status: 'PENDING' | 'CONFIRMED' | 'PAID';
    created_at: string;
}

const VendorDashboard: React.FC<VendorDashboardProps> = ({ user, tenantId, teachers = [], onNavigate }) => {
    const [commissions, setCommissions] = useState<Commission[]>([]);
    const [commissionRate, setCommissionRate] = useState(3000); // centavos
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    const myReferralBase = `${APP_BASE_URL}/matricula?vendor_id=${user.id}`;

    useEffect(() => {
        fetchData();
    }, [user.id]);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Busca taxa de comissão do vendedor
            const { data: profile } = await supabase
                .from('profiles')
                .select('commission_rate')
                .eq('id', user.id)
                .single();

            if (profile?.commission_rate) {
                setCommissionRate(profile.commission_rate);
            }

            // Busca comissões
            const { data: comms } = await supabase
                .from('vendor_commissions')
                .select(`
                    id,
                    amount_brl,
                    status,
                    created_at,
                    student:student_id(full_name)
                `)
                .eq('vendor_id', user.id)
                .order('created_at', { ascending: false });

            if (comms) {
                setCommissions(comms.map((c: any) => ({
                    id: c.id,
                    student_name: c.student?.full_name || 'Aluno',
                    amount_brl: c.amount_brl,
                    status: c.status,
                    created_at: c.created_at
                })));
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const copyLink = (link: string) => {
        navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const totalPending = commissions.filter(c => c.status === 'PENDING').reduce((s, c) => s + c.amount_brl, 0);
    const totalConfirmed = commissions.filter(c => c.status === 'CONFIRMED').reduce((s, c) => s + c.amount_brl, 0);
    const totalPaid = commissions.filter(c => c.status === 'PAID').reduce((s, c) => s + c.amount_brl, 0);

    const statusBadge = (status: string) => {
        const map: Record<string, string> = {
            PENDING: 'bg-amber-50 text-amber-600 border-amber-200',
            CONFIRMED: 'bg-blue-50 text-blue-600 border-blue-200',
            PAID: 'bg-emerald-50 text-emerald-600 border-emerald-200'
        };
        const label: Record<string, string> = { PENDING: 'Aguardando', CONFIRMED: 'Confirmada', PAID: 'Pago' };
        return (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${map[status] || ''}`}>
                {label[status] || status}
            </span>
        );
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <header>
                <h2 className="text-2xl font-black text-gray-800 dark:text-slate-100 flex items-center gap-3">
                    <TrendingUp className="text-tenant-primary" size={28} /> Painel do Vendedor
                </h2>
                <p className="text-gray-500 dark:text-slate-400 text-sm mt-1">
                    Comissão por matrícula: <strong className="text-emerald-600">R$ {(commissionRate / 100).toFixed(2)}</strong>
                </p>
            </header>

            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="p-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl"><Clock size={20} className="text-amber-600" /></div>
                        <p className="text-xs font-black uppercase tracking-widest text-gray-400">Pendente</p>
                    </div>
                    <p className="text-2xl font-black text-gray-800 dark:text-white">R$ {(totalPending / 100).toFixed(2)}</p>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-xl"><CheckCircle size={20} className="text-blue-600" /></div>
                        <p className="text-xs font-black uppercase tracking-widest text-gray-400">Confirmado</p>
                    </div>
                    <p className="text-2xl font-black text-gray-800 dark:text-white">R$ {(totalConfirmed / 100).toFixed(2)}</p>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl"><Award size={20} className="text-emerald-600" /></div>
                        <p className="text-xs font-black uppercase tracking-widest text-gray-400">Pago</p>
                    </div>
                    <p className="text-2xl font-black text-gray-800 dark:text-white">R$ {(totalPaid / 100).toFixed(2)}</p>
                </div>
            </div>

            {/* Ferramentas rápidas */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Link de matrícula com vendor_id */}
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
                    <h3 className="font-black text-sm text-gray-800 dark:text-white mb-1 flex items-center gap-2">
                        <Link size={16} className="text-tenant-primary" /> Meu Link de Matrícula
                    </h3>
                    <p className="text-xs text-gray-400 mb-3">Toda matrícula via este link será vinculada a você.</p>
                    <div className="bg-gray-50 dark:bg-slate-800 rounded-xl p-3 flex items-center gap-2">
                        <code className="text-[10px] text-gray-500 dark:text-slate-400 flex-1 truncate">{myReferralBase}</code>
                        <button
                            onClick={() => copyLink(myReferralBase)}
                            className="shrink-0 p-2 bg-tenant-primary text-white rounded-lg hover:brightness-110 transition-all"
                        >
                            {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
                        </button>
                    </div>
                </div>

                {/* Atalhos */}
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
                    <h3 className="font-black text-sm text-gray-800 dark:text-white mb-3 flex items-center gap-2">
                        <Calendar size={16} className="text-tenant-primary" /> Ações Rápidas
                    </h3>
                    <div className="space-y-2">
                        <button
                            onClick={() => onNavigate?.('vendor_schedule')}
                            className="w-full text-left px-4 py-3 bg-gray-50 dark:bg-slate-800 hover:bg-tenant-primary/5 dark:hover:bg-slate-700 rounded-xl text-xs font-bold text-gray-700 dark:text-slate-300 flex items-center gap-3 transition-all"
                        >
                            <Calendar size={14} className="text-tenant-primary" /> Ver disponibilidade de professores
                        </button>
                        <button
                            onClick={() => onNavigate?.('vendor_enrollment')}
                            className="w-full text-left px-4 py-3 bg-gray-50 dark:bg-slate-800 hover:bg-tenant-primary/5 dark:hover:bg-slate-700 rounded-xl text-xs font-bold text-gray-700 dark:text-slate-300 flex items-center gap-3 transition-all"
                        >
                            <Link size={14} className="text-tenant-primary" /> Gerar link de matrícula personalizado
                        </button>
                    </div>
                </div>
            </div>

            {/* Tabela de comissões */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-hidden">
                <div className="p-6 border-b dark:border-slate-800">
                    <h3 className="font-black text-xs uppercase tracking-widest text-gray-500 dark:text-slate-400 flex items-center gap-2">
                        <DollarSign size={14} /> Histórico de Comissões
                    </h3>
                </div>
                {loading ? (
                    <div className="p-12 text-center text-gray-300 dark:text-slate-600 text-sm">Carregando...</div>
                ) : commissions.length === 0 ? (
                    <div className="p-12 text-center">
                        <TrendingUp size={48} className="mx-auto opacity-20 mb-4" />
                        <p className="text-sm font-bold text-gray-400">Nenhuma comissão ainda</p>
                        <p className="text-xs text-gray-300 mt-1">Gere um link de matrícula e feche seu primeiro negócio!</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left min-w-[500px]">
                            <thead className="bg-gray-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-gray-400">
                                <tr>
                                    <th className="px-6 py-3">Aluno</th>
                                    <th className="px-6 py-3">Valor</th>
                                    <th className="px-6 py-3">Status</th>
                                    <th className="px-6 py-3">Data</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
                                {commissions.map(c => (
                                    <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-lg bg-tenant-primary/10 flex items-center justify-center">
                                                    <Users size={14} className="text-tenant-primary" />
                                                </div>
                                                <span className="text-sm font-bold text-gray-700 dark:text-slate-300">{c.student_name}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="text-sm font-black text-emerald-600">R$ {(c.amount_brl / 100).toFixed(2)}</span>
                                        </td>
                                        <td className="px-6 py-4">{statusBadge(c.status)}</td>
                                        <td className="px-6 py-4">
                                            <span className="text-xs text-gray-400">{new Date(c.created_at).toLocaleDateString('pt-BR')}</span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VendorDashboard;
