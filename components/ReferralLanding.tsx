import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Gift, User, Mail, Phone, ArrowRight, CheckCircle, Loader2, Clock, AlertCircle } from 'lucide-react';

const ReferralLanding: React.FC = () => {
    const [referrerId, setReferrerId] = useState<string | null>(null);
    const [referrerName, setReferrerName] = useState<string>('');
    const [loadingReferrer, setLoadingReferrer] = useState(true);
    const [invalidLink, setInvalidLink] = useState(false);

    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [alreadyRegistered, setAlreadyRegistered] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const ref = params.get('ref');
        if (!ref) {
            setInvalidLink(true);
            setLoadingReferrer(false);
            return;
        }
        setReferrerId(ref);
        fetchReferrerName(ref);
    }, []);

    const fetchReferrerName = async (id: string) => {
        try {
            const { data, error } = await supabase.rpc('get_referrer_name', { p_referrer_id: id });
            if (error || !data) {
                setInvalidLink(true);
            } else {
                setReferrerName(data);
            }
        } catch {
            setInvalidLink(true);
        } finally {
            setLoadingReferrer(false);
        }
    };

    const formatPhone = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 11);
        if (digits.length <= 2) return digits;
        if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
        return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!referrerId) return;
        setError(null);
        setLoading(true);

        try {
            // Verifica se o email já foi cadastrado como indicado
            const { data: existing } = await supabase
                .from('referral_invites')
                .select('id, status')
                .eq('invitee_email', email.toLowerCase().trim())
                .eq('referrer_id', referrerId)
                .maybeSingle();

            if (existing) {
                if (existing.status === 'CONVERTED') {
                    setAlreadyRegistered(true);
                    setSuccess(true);
                    return;
                }
                // Já existe invite PENDING — atualiza dados
                await supabase
                    .from('referral_invites')
                    .update({
                        invitee_name: name.trim(),
                        invitee_phone: phone.replace(/\D/g, ''),
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                    })
                    .eq('id', existing.id);
            } else {
                const { error: insertErr } = await supabase
                    .from('referral_invites')
                    .insert({
                        referrer_id: referrerId,
                        invitee_name: name.trim(),
                        invitee_email: email.toLowerCase().trim(),
                        invitee_phone: phone.replace(/\D/g, ''),
                    });

                if (insertErr) throw new Error(insertErr.message);
            }

            // Disparo automático de WhatsApp de boas-vindas (não-bloqueante)
            supabase.functions.invoke('referral-welcome', {
                body: {
                    invitee_name: name.trim(),
                    invitee_phone: phone.replace(/\D/g, ''),
                    referrer_id: referrerId,
                }
            }).catch(e => console.warn('referral-welcome disparo:', e));

            setSuccess(true);
        } catch (err: any) {
            setError('Ocorreu um erro. Tente novamente.');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    if (loadingReferrer) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-navy-950 to-slate-900 flex items-center justify-center">
                <Loader2 className="animate-spin text-emerald-400" size={32} />
            </div>
        );
    }

    if (invalidLink) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
                <div className="bg-slate-800/60 border border-slate-700 rounded-3xl p-10 max-w-md w-full text-center shadow-2xl">
                    <div className="w-16 h-16 bg-red-500/15 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <AlertCircle size={28} className="text-red-400" />
                    </div>
                    <h2 className="text-xl font-black text-white mb-2">Link inválido</h2>
                    <p className="text-slate-400 text-sm">
                        Este link de indicação não é válido. Peça um novo link para quem te indicou.
                    </p>
                </div>
            </div>
        );
    }

    if (success) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-emerald-950/20 to-slate-950 flex items-center justify-center p-4">
                <div className="bg-slate-800/60 border border-emerald-700/40 rounded-3xl p-10 max-w-md w-full text-center shadow-2xl">
                    <div className="w-20 h-20 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-emerald-500/30">
                        <CheckCircle size={36} className="text-emerald-400" />
                    </div>
                    <h2 className="text-2xl font-black text-white mb-3">
                        {alreadyRegistered ? 'Você já está cadastrado!' : 'Interesse registrado!'}
                    </h2>
                    <p className="text-slate-300 text-sm leading-relaxed mb-6">
                        {alreadyRegistered
                            ? 'Você já se matriculou na Wise Wolf. Obrigado!'
                            : `Ótimo! A Wise Wolf Language School vai entrar em contato com você em breve para apresentar os planos disponíveis.\n\nAssim que você fechar um plano, ${referrerName} recebe o bônus de indicação automaticamente! 🐺`
                        }
                    </p>
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4">
                        <div className="flex items-center justify-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider">
                            <Clock size={14} />
                            <span>Válido por 30 dias</span>
                        </div>
                        <p className="text-slate-400 text-xs mt-1">
                            O bônus é liberado quando sua matrícula for confirmada
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
            {/* Background glow */}
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

            <div className="relative w-full max-w-md">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-6">
                        <Gift size={14} className="text-emerald-400" />
                        <span className="text-emerald-400 text-xs font-black uppercase tracking-widest">Indicação Wise Wolf</span>
                    </div>
                    <h1 className="text-3xl font-black text-white tracking-tight mb-3">
                        🐺 Você foi indicado!
                    </h1>
                    <p className="text-slate-400 text-sm leading-relaxed">
                        <span className="text-emerald-400 font-bold">{referrerName}</span> te convidou para aprender inglês na{' '}
                        <span className="text-white font-bold">Wise Wolf Language School</span>.
                        <br />Preencha seus dados e entraremos em contato!
                    </p>
                </div>

                {/* Card */}
                <div className="bg-slate-800/50 border border-slate-700/60 rounded-3xl p-8 shadow-2xl backdrop-blur-sm">
                    {/* Benefits */}
                    <div className="grid grid-cols-3 gap-3 mb-8">
                        {[
                            { emoji: '🎯', label: 'Aula experimental gratuita' },
                            { emoji: '🏆', label: 'Professores nativos' },
                            { emoji: '💬', label: 'Método conversacional' },
                        ].map(({ emoji, label }) => (
                            <div key={label} className="bg-slate-700/40 rounded-xl p-3 text-center border border-slate-600/30">
                                <span className="text-xl block mb-1">{emoji}</span>
                                <p className="text-slate-400 text-[10px] font-bold leading-tight">{label}</p>
                            </div>
                        ))}
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* Nome */}
                        <div>
                            <label className="block text-xs font-black uppercase tracking-widest text-slate-400 mb-2">
                                Nome completo
                            </label>
                            <div className="relative">
                                <User size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input
                                    type="text"
                                    required
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    placeholder="Seu nome"
                                    className="w-full bg-slate-700/50 border border-slate-600/50 text-white placeholder-slate-500 rounded-xl pl-10 pr-4 py-3.5 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
                                />
                            </div>
                        </div>

                        {/* Email */}
                        <div>
                            <label className="block text-xs font-black uppercase tracking-widest text-slate-400 mb-2">
                                E-mail
                            </label>
                            <div className="relative">
                                <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input
                                    type="email"
                                    required
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    placeholder="seu@email.com"
                                    className="w-full bg-slate-700/50 border border-slate-600/50 text-white placeholder-slate-500 rounded-xl pl-10 pr-4 py-3.5 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
                                />
                            </div>
                        </div>

                        {/* WhatsApp */}
                        <div>
                            <label className="block text-xs font-black uppercase tracking-widest text-slate-400 mb-2">
                                WhatsApp
                            </label>
                            <div className="relative">
                                <Phone size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input
                                    type="tel"
                                    required
                                    value={phone}
                                    onChange={e => setPhone(formatPhone(e.target.value))}
                                    placeholder="(11) 99999-9999"
                                    className="w-full bg-slate-700/50 border border-slate-600/50 text-white placeholder-slate-500 rounded-xl pl-10 pr-4 py-3.5 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
                                />
                            </div>
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                                <AlertCircle size={14} className="text-red-400 shrink-0" />
                                <p className="text-red-400 text-xs font-medium">{error}</p>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-60 text-white font-black text-sm uppercase tracking-widest rounded-xl py-4 flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-emerald-500/25 mt-2"
                        >
                            {loading ? (
                                <Loader2 size={18} className="animate-spin" />
                            ) : (
                                <>
                                    Quero aprender inglês
                                    <ArrowRight size={16} />
                                </>
                            )}
                        </button>
                    </form>

                    <p className="text-slate-500 text-[10px] text-center mt-4 leading-relaxed">
                        Seus dados são usados apenas para entrar em contato sobre a matrícula.
                        Sem spam, prometemos! 🐺
                    </p>
                </div>

                {/* Referrer bonus note */}
                <div className="mt-4 text-center">
                    <p className="text-slate-600 text-xs">
                        Quando você se matricular, <span className="text-emerald-500 font-bold">{referrerName}</span> ganha um bônus especial 🎁
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ReferralLanding;
