import React, { useState, useEffect } from 'react';
import {
    Gift, Copy, Check, Users, TrendingUp, Link2,
    Share2, ChevronRight, Sparkles, Clock, Award,
    MessageCircle, ExternalLink
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { UserRole } from '../types';

interface AffiliatePanelProps {
    user: {
        id: string;
        name?: string;
        role: UserRole;
    };
}

interface ReferredUser {
    id: string;
    full_name: string;
    created_at: string;
    role: string;
}

interface AffiliateStats {
    referrals: number;
    totalEarnings: number;
    recentReferrals: ReferredUser[];
}

const BONUS_PER_REFERRAL = 45;

const AffiliatePanel: React.FC<AffiliatePanelProps> = ({ user }) => {
    const [copied, setCopied] = useState(false);
    const [stats, setStats] = useState<AffiliateStats>({
        referrals: 0,
        totalEarnings: 0,
        recentReferrals: []
    });
    const [loading, setLoading] = useState(true);

    const isTeacher = user.role === UserRole.TEACHER;
    const isStudent = user.role === UserRole.STUDENT;
    const isAdmin = user.role === UserRole.SCHOOL_ADMIN;

    // Gerar link único por role
    const affiliateLink = isTeacher || isAdmin
        ? `${APP_BASE_URL}/matricula?ref=${user.id}`
        : `${APP_BASE_URL}/matricula?ref_student=${user.id}`;

    const referrerColumn = isTeacher || isAdmin ? 'referrer_teacher_id' : 'referrer_student_id';

    useEffect(() => {
        fetchStats();
    }, [user.id]);

    const fetchStats = async () => {
        setLoading(true);
        try {
            const { data, count } = await supabase
                .from('profiles')
                .select('id, full_name, created_at, role', { count: 'exact' })
                .eq(referrerColumn, user.id)
                .order('created_at', { ascending: false })
                .limit(5);

            setStats({
                referrals: count || 0,
                totalEarnings: (count || 0) * BONUS_PER_REFERRAL,
                recentReferrals: data || []
            });
        } catch (err) {
            console.error('Error fetching affiliate stats:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(affiliateLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
    };

    const handleShareWhatsApp = () => {
        const msg = encodeURIComponent(
            `🐺 Ei! Eu estou estudando inglês na Wise Wolf Language School e tô amando!\n\n` +
            `Se você também quer falar inglês de verdade, se matricule pelo meu link e garanta sua vaga:\n\n` +
            `👉 ${affiliateLink}\n\n` +
            `Vamos aprender juntos! 🚀`
        );
        window.open(`https://wa.me/?text=${msg}`, '_blank');
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">

            {/* ── Hero / CTA Banner ── */}
            <div className="relative rounded-[2.5rem] overflow-hidden bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 text-white shadow-2xl shadow-emerald-500/30">
                {/* Background decorations */}
                <div className="absolute top-0 right-0 w-72 h-72 bg-brand-surface/10 rounded-full blur-3xl -translate-y-1/3 translate-x-1/4 pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-black/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />
                <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg width=%2260%22 height=%2260%22 viewBox=%220 0 60 60%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cg fill=%22none%22 fill-rule=%22evenodd%22%3E%3Cg fill=%22%23ffffff%22 fill-opacity=%220.03%22%3E%3Cpath d=%22M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z%22/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')] opacity-50" />

                <div className="relative z-10 p-8 md:p-10">
                    <div className="flex items-start justify-between mb-6">
                        <div>
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-brand-surface/15 backdrop-blur-sm border border-white/20 rounded-full text-[10px] font-black uppercase tracking-widest text-emerald-100 mb-4">
                                <Gift size={12} />
                                <span>Programa de Indicação</span>
                            </div>
                            <h1 className="text-3xl md:text-4xl font-black tracking-tighter mb-2">
                                Indique & Ganhe
                            </h1>
                            <p className="text-emerald-100/90 font-medium text-base max-w-sm">
                                Cada amigo que se matricular pelo seu link vale{' '}
                                <span className="font-black text-white">R$ {BONUS_PER_REFERRAL},00</span> pra você!
                            </p>
                        </div>
                        <div className="hidden md:flex w-20 h-20 bg-brand-surface/15 backdrop-blur rounded-3xl items-center justify-center border border-white/20 shrink-0">
                            <Gift size={36} className="text-emerald-100" />
                        </div>
                    </div>

                    {/* How it works */}
                    <div className="grid grid-cols-3 gap-3 mb-6">
                        {[
                            { step: '1', label: 'Copie seu link único' },
                            { step: '2', label: 'Compartilhe com amigos' },
                            { step: '3', label: 'Ganhe R$45 por matrícula' },
                        ].map(({ step, label }) => (
                            <div key={step} className="bg-brand-surface/10 backdrop-blur-sm border border-white/15 rounded-2xl p-3 text-center">
                                <div className="w-7 h-7 bg-brand-surface/20 rounded-full flex items-center justify-center mx-auto mb-2">
                                    <span className="text-xs font-black text-white">{step}</span>
                                </div>
                                <p className="text-[10px] font-bold text-emerald-100 leading-tight">{label}</p>
                            </div>
                        ))}
                    </div>

                    {/* Link box */}
                    <div className="bg-black/20 backdrop-blur-sm border border-white/15 rounded-2xl p-3 flex items-center gap-3">
                        <Link2 size={16} className="text-emerald-300 shrink-0" />
                        <input
                            readOnly
                            value={affiliateLink}
                            className="flex-1 bg-transparent text-xs font-mono text-emerald-200 outline-none truncate min-w-0"
                            onClick={e => (e.target as HTMLInputElement).select()}
                        />
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={handleShareWhatsApp}
                                className="w-9 h-9 bg-green-500 hover:bg-green-400 text-white rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-lg shadow-green-600/30"
                                title="Compartilhar no WhatsApp"
                            >
                                <MessageCircle size={16} />
                            </button>
                            <button
                                onClick={handleCopy}
                                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold text-[11px] uppercase tracking-wider transition-all hover:scale-105 active:scale-95 ${
                                    copied
                                        ? 'bg-emerald-400 text-white shadow-lg shadow-emerald-400/30'
                                        : 'bg-brand-surface text-emerald-700 hover:bg-emerald-50 shadow-lg shadow-black/10'
                                }`}
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                                {copied ? 'Copiado!' : 'Copiar'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Stats Cards ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Total Indicações */}
                <div className="bg-brand-surface rounded-[2rem] p-6 border border-brand-border shadow-sm hover:-translate-y-1 transition-transform group relative overflow-hidden">
                    <div className="absolute -top-8 -right-8 w-32 h-32 bg-gradient-to-b from-teal-400/15 to-transparent rounded-full blur-2xl group-hover:from-teal-400/25 transition-colors" />
                    <div className="flex items-center justify-between mb-4">
                        <div className="p-2.5 bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 rounded-xl">
                            <Users size={22} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Total</span>
                    </div>
                    <p className="text-4xl font-black text-brand-text tracking-tighter">
                        {loading ? '—' : stats.referrals}
                    </p>
                    <p className="text-sm font-bold text-teal-600 dark:text-teal-400 mt-1">
                        {stats.referrals === 1 ? 'Indicação convertida' : 'Indicações convertidas'}
                    </p>
                </div>

                {/* Total Ganho */}
                <div className="bg-brand-surface rounded-[2rem] p-6 border border-brand-border shadow-sm hover:-translate-y-1 transition-transform group relative overflow-hidden">
                    <div className="absolute -top-8 -right-8 w-32 h-32 bg-gradient-to-b from-emerald-400/15 to-transparent rounded-full blur-2xl group-hover:from-emerald-400/25 transition-colors" />
                    <div className="flex items-center justify-between mb-4">
                        <div className="p-2.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-xl">
                            <TrendingUp size={22} />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Bônus</span>
                    </div>
                    <p className="text-4xl font-black text-brand-text tracking-tighter">
                        {loading ? '—' : `R$ ${stats.totalEarnings.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
                    </p>
                    <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                        Acumulado em indicações
                    </p>
                </div>
            </div>

            {/* ── Histórico de Indicados ── */}
            <div className="bg-brand-surface rounded-[2rem] border border-brand-border shadow-sm overflow-hidden">
                <div className="px-6 py-5 border-b border-brand-border flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Award size={18} className="text-emerald-500" />
                        <h3 className="font-black text-brand-text text-sm uppercase tracking-wider">
                            Indicados Recentes
                        </h3>
                    </div>
                    {stats.referrals > 0 && (
                        <span className="px-2.5 py-1 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-[10px] font-black rounded-full uppercase tracking-widest">
                            {stats.referrals} total
                        </span>
                    )}
                </div>

                <div className="divide-y divide-slate-50 dark:divide-slate-800">
                    {loading ? (
                        <div className="p-8 flex items-center justify-center">
                            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : stats.recentReferrals.length > 0 ? (
                        stats.recentReferrals.map((ref) => (
                            <div key={ref.id} className="flex items-center gap-4 px-6 py-4 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/50 transition-colors">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white font-black text-sm shrink-0 shadow-sm">
                                    {ref.full_name?.charAt(0)?.toUpperCase() || '?'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="font-bold text-brand-text text-sm truncate">
                                        {ref.full_name || 'Aluno'}
                                    </p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <Clock size={10} className="text-brand-muted" />
                                        <p className="text-[10px] font-medium text-brand-muted">
                                            {formatDate(ref.created_at)}
                                        </p>
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                                        +R$ 45,00
                                    </p>
                                    <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wide">bônus</p>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="p-10 text-center">
                            <div className="w-16 h-16 bg-brand-surface-2 rounded-3xl flex items-center justify-center mx-auto mb-4 border border-brand-border dark:border-brand-border">
                                <Share2 size={24} className="text-slate-300 dark:text-brand-muted" />
                            </div>
                            <h4 className="font-black text-brand-text dark:text-slate-300 mb-1">
                                Nenhuma indicação ainda
                            </h4>
                            <p className="text-sm text-brand-muted font-medium max-w-xs mx-auto">
                                Compartilhe seu link e comece a ganhar R$ 45,00 por cada amigo matriculado!
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Share Tips ── */}
            <div className="bg-gradient-to-br from-slate-50 to-emerald-50/30 dark:from-slate-900 dark:to-emerald-900/5 rounded-[2rem] p-6 border border-emerald-100 dark:border-emerald-900/20">
                <div className="flex items-center gap-2 mb-4">
                    <Sparkles size={16} className="text-emerald-500" />
                    <h4 className="font-black text-brand-text dark:text-slate-300 text-sm uppercase tracking-wider">
                        Dicas para vender mais
                    </h4>
                </div>
                <ul className="space-y-2.5">
                    {[
                        { tip: 'Mande o link no status do WhatsApp', icon: '📲' },
                        { tip: 'Indique para quem já falou em aprender inglês', icon: '💬' },
                        { tip: 'Compartilhe nos seus stories com depoimento pessoal', icon: '🌟' },
                        { tip: 'Cada matrícula confirmada = R$ 45,00 garantidos', icon: '💰' },
                    ].map(({ tip, icon }) => (
                        <li key={tip} className="flex items-start gap-3">
                            <span className="text-base shrink-0 mt-0.5">{icon}</span>
                            <p className="text-sm font-medium text-brand-muted dark:text-brand-muted">{tip}</p>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

export default AffiliatePanel;
