import React, { useState, useEffect } from 'react';
import { Link2, Copy, Check, Gift, Users, TrendingUp } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';

interface TeacherAffiliateCardProps {
    user: { id: string; name?: string };
}

const TeacherAffiliateCard: React.FC<TeacherAffiliateCardProps> = ({ user }) => {
    const [copied, setCopied] = useState(false);
    const [stats, setStats] = useState({ referrals: 0, totalEarnings: 0 });

    const affiliateLink = `${APP_BASE_URL}/matricula?ref=${user.id}`;

    useEffect(() => {
        fetchAffiliateStats();
    }, [user.id]);

    const fetchAffiliateStats = async () => {
        try {
            // Count students referred by this teacher
            const { count } = await supabase
                .from('profiles')
                .select('id', { count: 'exact', head: true })
                .eq('referrer_teacher_id', user.id)
                .eq('role', 'STUDENT');

            const referrals = count || 0;
            setStats({
                referrals,
                totalEarnings: referrals * 49 // R$49 fixos por indicação
            });
        } catch (err) {
            console.error('Error fetching affiliate stats:', err);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(affiliateLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-r from-emerald-500 to-teal-600 p-6 text-white relative overflow-hidden">
                <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-1">
                        <Gift size={18} className="text-emerald-200" />
                        <h3 className="text-sm font-black uppercase tracking-wider">Programa de Indicação</h3>
                    </div>
                    <p className="text-emerald-100/80 text-xs">Indique alunos e ganhe R$ 49,00 por matrícula convertida</p>
                </div>
                <div className="absolute -right-6 -top-6 w-24 h-24 bg-white/10 rounded-full blur-xl" />
            </div>

            <div className="p-6 space-y-4">
                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl text-center">
                        <div className="flex items-center justify-center gap-1 text-emerald-600 mb-1">
                            <Users size={14} />
                        </div>
                        <p className="text-xl font-black text-slate-800 dark:text-white">{stats.referrals}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Indicações</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl text-center">
                        <div className="flex items-center justify-center gap-1 text-emerald-600 mb-1">
                            <TrendingUp size={14} />
                        </div>
                        <p className="text-xl font-black text-slate-800 dark:text-white">
                            R$ {stats.totalEarnings.toFixed(2)}
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Ganho</p>
                    </div>
                </div>

                {/* Link */}
                <div className="bg-slate-900 dark:bg-slate-800 rounded-xl p-3 flex items-center gap-3">
                    <Link2 size={16} className="text-emerald-400 shrink-0" />
                    <input
                        readOnly
                        value={affiliateLink}
                        className="flex-1 bg-transparent text-xs font-mono text-emerald-400 outline-none truncate"
                    />
                    <button
                        onClick={handleCopy}
                        className={`px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-wider transition-all flex items-center gap-1 ${copied
                                ? 'bg-emerald-500 text-white'
                                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                            }`}
                    >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? 'Copiado!' : 'Copiar'}
                    </button>
                </div>

                <p className="text-[10px] text-slate-400 text-center font-medium">
                    Compartilhe este link. Quando o aluno fechar contrato, você recebe R$ 49,00 + aulas recorrentes normais.
                </p>
            </div>
        </div>
    );
};

export default TeacherAffiliateCard;
