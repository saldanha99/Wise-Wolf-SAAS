import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User, Mail, Lock, Phone, CheckCircle, AlertCircle, ArrowRight, Loader2, Target, Camera, FileText } from 'lucide-react';

const CommercialOnboarding: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'SUCCESS'>('OFFER');
    const [error, setError] = useState<string | null>(null);
    const [offerData, setOfferData] = useState<any>(null);

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const jwtToken = params.get('token');
        const encodedOffer = params.get('offer');

        const loadOffer = async () => {
            try {
                const { resolveOffer } = await import('../services/offerService');
                const result = await resolveOffer({
                    token: jwtToken,
                    legacyOffer: encodedOffer,
                    route: '/commercial-onboarding',
                });

                if (result.success && result.payload) {
                    setOfferData({
                        ...result.payload,
                        _offerId: result.offerId,
                        _source: result.source,
                    });
                } else {
                    setError(result.message || 'Link de convite inválido ou expirado.');
                }
            } catch (e) {
                // Last resort: try local Base64 decode (retro-compat)
                if (encodedOffer) {
                    try {
                        const jsonStr = decodeURIComponent(atob(encodedOffer).split('').map(function (c) {
                            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                        }).join(''));
                        const data = JSON.parse(jsonStr);
                        setOfferData(data);
                        console.warn('[CommercialOnboarding] ⚠️ Using local Base64 fallback');
                    } catch {
                        setError('Link de convite inválido ou expirado.');
                    }
                } else {
                    setError('Link de convite inválido. Solicite um novo link.');
                }
            }
        };

        if (jwtToken || encodedOffer) {
            loadOffer();
        } else {
            setError('Link de convite inválido.');
        }
    }, []);

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!offerData) return;
        setLoading(true);
        setError(null);

        try {
            // We'll use a modified Edge Function or a new one
            // If the user hasn't created 'register-user', this might fail.
            // I will provide the Edge Function code in the next step.
            const { data, error: fnError } = await supabase.functions.invoke('register-user', {
                body: {
                    email,
                    password,
                    name,
                    phone: phone.replace(/\D/g, ''),
                    role: 'COMMERCIAL',
                    tenantId: offerData.tenantId,
                    avatar: avatarUrl,
                    metadata: {
                        department: offerData.department
                    }
                }
            });

            if (fnError) throw new Error(fnError.message || "Erro ao conectar com o servidor.");
            if (data?.error) throw new Error(data.error);

            // Consume the signed offer (if it was JWT-based) to prevent reuse
            if (offerData._offerId) {
                supabase.rpc('consume_offer', { p_offer_id: offerData._offerId })
                    .then(() => console.log('✅ Offer consumed:', offerData._offerId))
                    .catch((e: any) => console.warn('consume_offer failed (non-blocking):', e));
            }

            setStep('SUCCESS');
        } catch (err: any) {
            console.error(err);
            setError(err.message || "Ocorreu um erro no cadastro.");
        } finally {
            setLoading(false);
        }
    };

    if (error) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 mb-2">Ops! Link Inválido</h2>
                    <p className="text-slate-500 mb-6">{error}</p>
                    <a href="/" className="text-tenant-primary font-bold hover:underline">Voltar ao Início</a>
                </div>
            </div>
        );
    }

    if (!offerData) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;
    }

    if (step === 'SUCCESS') {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
                <div className="bg-white p-12 rounded-[3rem] shadow-2xl max-w-lg w-full text-center animate-in zoom-in duration-500">
                    <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-8">
                        <CheckCircle size={48} className="text-emerald-600" />
                    </div>
                    <h2 className="text-3xl font-black text-slate-800 mb-4 tracking-tight">Bem-vindo ao Time! 🐺</h2>
                    <p className="text-slate-600 mb-10 font-medium leading-relaxed">
                        Seu perfil comercial foi criado com sucesso. Agora você tem acesso a todas as ferramentas de vendas da unidade.
                    </p>
                    <a href="/" className="block w-full px-8 py-5 bg-tenant-primary text-white rounded-2xl font-black uppercase tracking-widest hover:brightness-110 transition-all shadow-xl shadow-tenant-primary/30">
                        Acessar Portal Comercial
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100 py-12 px-4 font-sans flex items-center justify-center">
            <div className="max-w-5xl w-full flex flex-col md:flex-row bg-white rounded-[3rem] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] overflow-hidden border border-white">
                
                {/* Info Panel */}
                <div className="bg-[#002366] p-12 md:w-2/5 text-white flex flex-col justify-between relative overflow-hidden">
                    <div className="relative z-10">
                        <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mb-8 backdrop-blur-md border border-white/10">
                            <Target size={32} className="text-indigo-300" />
                        </div>
                        <h1 className="text-4xl font-black uppercase tracking-tighter leading-none mb-4">Time Comercial</h1>
                        <p className="text-indigo-200 text-lg font-medium opacity-80">Junte-se à Wolfie e ajude a transformar a educação com tecnologia.</p>
                    </div>

                    <div className="relative z-10 space-y-6 mt-12">
                        <div className="p-6 bg-white/5 rounded-[2rem] border border-white/10 backdrop-blur-sm">
                            <p className="text-xs font-black uppercase tracking-widest text-indigo-300 mb-2">Departamento</p>
                            <p className="text-2xl font-bold">{offerData.department}</p>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-indigo-100/60 font-medium">
                            <CheckCircle size={16} className="text-emerald-400" /> Acesso ao CRM & Leads
                        </div>
                        <div className="flex items-center gap-4 text-sm text-indigo-100/60 font-medium">
                            <CheckCircle size={16} className="text-emerald-400" /> Geração de Matrículas
                        </div>
                    </div>

                    {/* Decorative Elements */}
                    <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-indigo-500/20 rounded-full blur-3xl" />
                    <div className="absolute -top-20 -right-20 w-64 h-64 bg-purple-500/20 rounded-full blur-3xl" />
                </div>

                {/* Form Panel */}
                <div className="p-12 md:w-3/5 overflow-y-auto max-h-[90vh]">
                    <div className="max-w-md mx-auto">
                        <h2 className="text-3xl font-black text-slate-800 mb-2 tracking-tight">Criar Perfil</h2>
                        <p className="text-slate-500 mb-10 font-medium">Preencha seus dados para começar.</p>

                        <form onSubmit={handleRegister} className="space-y-6">
                            <div className="flex items-center gap-6 mb-8">
                                <div className="w-20 h-20 rounded-3xl bg-slate-50 border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-300 relative group overflow-hidden">
                                    {avatarUrl ? <img src={avatarUrl} className="w-full h-full object-cover" /> : <Camera size={32} />}
                                </div>
                                <div className="flex-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 ml-1">URL da Foto</label>
                                    <input 
                                        type="text" 
                                        placeholder="https://..." 
                                        value={avatarUrl}
                                        onChange={e => setAvatarUrl(e.target.value)}
                                        className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-tenant-primary transition-all outline-none"
                                    />
                                </div>
                            </div>

                            <div className="space-y-5">
                                <Input label="Nome Completo" value={name} onChange={(e: any) => setName(e.target.value)} icon={<User size={18} />} required />
                                <Input label="E-mail" type="email" value={email} onChange={(e: any) => setEmail(e.target.value)} icon={<Mail size={18} />} required />
                                <Input label="Senha" type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} icon={<Lock size={18} />} required />
                                <Input label="WhatsApp" value={phone} onChange={(e: any) => setPhone(e.target.value)} icon={<Phone size={18} />} required />
                            </div>

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full py-5 bg-tenant-primary text-white rounded-[2rem] font-black text-sm uppercase tracking-widest shadow-2xl shadow-indigo-900/30 hover:brightness-110 hover:-translate-y-1 transition-all flex items-center justify-center gap-3 mt-10 disabled:opacity-50 disabled:translate-y-0"
                            >
                                {loading ? <Loader2 className="animate-spin" /> : <><CheckCircle size={20} /> Concluir Cadastro</>}
                            </button>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
};

const Input = ({ label, value, onChange, icon, type = "text", required = false }: any) => (
    <div className="group">
        <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 ml-1">
            {label} {required && <span className="text-red-400">*</span>}
        </label>
        <div className="relative">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-tenant-primary transition-colors">
                {icon}
            </div>
            <input
                type={type}
                required={required}
                value={value}
                onChange={onChange}
                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-tenant-primary/20 outline-none transition-all placeholder:text-slate-300"
            />
        </div>
    </div>
);

export default CommercialOnboarding;
