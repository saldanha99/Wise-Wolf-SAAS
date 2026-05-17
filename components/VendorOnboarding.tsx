import React, { useState, useEffect } from 'react';
import { Briefcase, User, Mail, Lock, Phone, AlertCircle, CheckCircle, Loader2, DollarSign } from 'lucide-react';
import { supabase } from '../lib/supabase';

const VendorOnboarding: React.FC = () => {
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'SUCCESS'>('OFFER');
    const [offerData, setOfferData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const encodedOffer = params.get('offer');

        if (!encodedOffer) {
            setError('Link inválido.');
            return;
        }
        try {
            const jsonStr = decodeURIComponent(atob(encodedOffer).split('').map(c =>
                '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
            ).join(''));
            const data = JSON.parse(jsonStr);

            if (data.kind !== 'VENDOR_INVITE') {
                setError('Link de convite inválido.');
                return;
            }
            if (data.exp && Date.now() > data.exp) {
                setError('Este link de convite expirou. Solicite um novo.');
                return;
            }
            setOfferData(data);
            if (data.suggestedName) setName(data.suggestedName);
        } catch (e) {
            setError('Link de convite corrompido.');
        }
    }, []);

    const handleRegister = async () => {
        if (!name || !email || !password) {
            setError('Preencha todos os campos obrigatórios.');
            return;
        }
        setLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams(window.location.search);
            const { data, error: fnError } = await supabase.functions.invoke('register-vendor', {
                body: {
                    email,
                    password,
                    name,
                    phone: phone.replace(/\D/g, ''),
                    offerPayload: params.get('offer'),
                }
            });

            if (fnError) throw new Error(fnError.message || 'Erro ao registrar.');
            if (data?.error) throw new Error(data.error);

            setStep('SUCCESS');
        } catch (err: any) {
            let msg = err.message;
            if (msg.includes('already registered')) msg = 'Este e-mail já está cadastrado.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    if (error && !offerData) {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Ops!</h2>
                    <p className="text-slate-500 mb-6">{error}</p>
                </div>
            </div>
        );
    }

    if (!offerData) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={32} /></div>;
    }

    if (step === 'SUCCESS') {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Cadastro concluído!</h2>
                    <p className="text-slate-500 mb-6">Sua conta de vendedor foi criada. Você pode fazer login agora.</p>
                    <a href="/" className="inline-block px-6 py-3 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110">
                        Ir para o login
                    </a>
                </div>
            </div>
        );
    }

    const commissionReais = (offerData.commissionRate / 100).toFixed(2);

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-xl max-w-md w-full overflow-hidden">
                <div className="bg-gradient-to-br from-violet-600 to-indigo-700 text-white p-6">
                    <div className="flex items-center gap-3 mb-3">
                        <Briefcase size={28} />
                        <h2 className="text-xl font-black">Bem-vindo ao time!</h2>
                    </div>
                    <p className="text-sm opacity-90">Cadastre-se como vendedor e comece a fechar matrículas.</p>

                    <div className="mt-4 bg-white/10 rounded-xl p-3">
                        <div className="flex items-center gap-2 text-xs opacity-80">
                            <DollarSign size={14} />
                            <span className="uppercase tracking-widest font-bold">Sua comissão</span>
                        </div>
                        <p className="text-2xl font-black mt-1">R$ {commissionReais} <span className="text-xs opacity-80">por matrícula confirmada</span></p>
                    </div>
                </div>

                <div className="p-6 space-y-3">
                    {error && (
                        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-start gap-2">
                            <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
                            <p className="text-xs text-rose-700">{error}</p>
                        </div>
                    )}

                    <Field icon={User} label="Nome completo" value={name} onChange={setName} placeholder="Seu nome" />
                    <Field icon={Mail} label="E-mail" value={email} onChange={setEmail} type="email" placeholder="voce@email.com" />
                    <Field icon={Lock} label="Senha" value={password} onChange={setPassword} type="password" placeholder="Crie uma senha forte" />
                    <Field icon={Phone} label="WhatsApp" value={phone} onChange={setPhone} placeholder="(11) 99999-9999" />

                    <button
                        onClick={handleRegister}
                        disabled={loading}
                        className="w-full py-3 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                        Criar minha conta
                    </button>
                </div>
            </div>
        </div>
    );
};

const Field: React.FC<{ icon: any; label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }> = ({ icon: Icon, label, value, onChange, placeholder, type = 'text' }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold block mb-1">{label}</label>
        <div className="relative">
            <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
        </div>
    </div>
);

export default VendorOnboarding;
