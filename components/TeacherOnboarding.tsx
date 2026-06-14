import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { whatsappService } from '../services/whatsappService';
import { User, Mail, Lock, Phone, Award, CheckCircle, AlertCircle, ArrowRight, Loader2, DollarSign, Camera, Link as LinkIcon, Briefcase, FileText } from 'lucide-react';
import { TeacherContractDocument } from './TeacherContractDocument';

const TeacherOnboarding: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'CONTRACT' | 'SUCCESS'>('OFFER');
    const [error, setError] = useState<string | null>(null);
    const [offerData, setOfferData] = useState<any>(null);

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');
    const [pixKey, setPixKey] = useState('');
    const [meetLink, setMeetLink] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');

    // New Fields for Contract
    const [rg, setRg] = useState('');
    const [cpf, setCpf] = useState('');
    const [address, setAddress] = useState('');
    const [birthDate, setBirthDate] = useState('');
    const [userIp, setUserIp] = useState('');
    const [contractAccepted, setContractAccepted] = useState(false);

    useEffect(() => {
        // 1. Decode Query Params
        const params = new URLSearchParams(window.location.search);
        const encodedOffer = params.get('offer');

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (encodedOffer && UUID_RE.test(encodedOffer.trim())) {
            // Caminho seguro: offer_id (UUID) → hora-aula AUTORITATIVA do servidor.
            (async () => {
                const { data: payload, error: offerErr } = await supabase.rpc('get_invite_offer_public', { p_offer_id: encodedOffer.trim() });
                if (offerErr || !payload || (payload as any).error) {
                    setError("Link de convite inválido, expirado ou já utilizado. Solicite um novo.");
                    return;
                }
                setOfferData(payload);
            })();
        } else if (encodedOffer) {
            // Caminho legado: base64 no URL.
            try {
                const jsonStr = decodeURIComponent(atob(encodedOffer).split('').map(function (c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
                const data = JSON.parse(jsonStr);
                setOfferData(data);
            } catch (e) {
                setError("Link de convite inválido ou expirado.");
            }
        } else {
            setError("Link de convite inválido.");
        }

        // 2. Fetch Public IP for judicial validity
        const fetchIp = async () => {
            try {
                const res = await fetch('https://api.ipify.org?format=json');
                const data = await res.json();
                if (data.ip) setUserIp(data.ip);
            } catch (e) {
                console.warn("⚠️ Falha ao capturar IP:", e);
                setUserIp('Oculto/CDN');
            }
        };
        fetchIp();
    }, []);

    const goToContract = (e: React.FormEvent) => {
        e.preventDefault();
        setStep('CONTRACT');
    };

    const handleRegister = async () => {
        if (!offerData || !contractAccepted) return;
        setLoading(true);
        setError(null);

        try {
            console.log("🚀 Enviando registro para Edge Function...");

            const { data, error: fnError } = await supabase.functions.invoke('register-teacher', {
                body: {
                    email,
                    password,
                    name,
                    phone: phone.replace(/\D/g, ''), // Send clean phone
                    pixKey,
                    meetLink,
                    avatar: avatarUrl,
                    offerPayload: new URLSearchParams(window.location.search).get('offer'),
                    rg,
                    cpf: cpf.replace(/\D/g, ''),
                    address,
                    birthDate,
                    contractAccepted: true,
                    acceptedAt: new Date().toISOString(),
                    userIp: userIp || 'Pendente'
                }
            });

            if (fnError) throw new Error(fnError.message || "Erro ao conectar com o servidor.");
            if (data?.error) throw new Error(data.error);

            const registeredUserId = data.userId;

            // CONSUME OFFER (BLOQUEANTE): impede reuso do link de convite.
            // Se falhar, aborta o cadastro antes de qualquer comunicação externa.
            if (offerData._offerId) {
                const { error: consumeErr } = await supabase.rpc('consume_offer', { p_offer_id: offerData._offerId });
                if (consumeErr) {
                    console.error('❌ consume_offer failed:', consumeErr);
                    throw new Error('Este link de convite já foi utilizado ou expirou. Solicite um novo link à escola.');
                }
                console.log('✅ Offer consumed:', offerData._offerId);
            }

            // AUTOMATION: Send Welcome WhatsApp with Contract Link (non-blocking)
            try {
                if (offerData?.tenantId && registeredUserId) {
                    console.log(`🚀 Iniciando disparo de boas-vindas para: ${phone}`);

                    const { data: instanceName, error: rpcError } = await supabase.rpc('get_tenant_whatsapp_instance', {
                        target_tenant_id: offerData.tenantId
                    });

                    if (instanceName && !rpcError) {
                        const contractUrl = `https://system.wisewolflanguage.com.br/view-contract?id=${registeredUserId}`;

                        const msg = `Olá ${name.split(' ')[0]}! Seja bem-vindo(a) à equipe! 🐺🚀\n\n` +
                            `*Seus dados de acesso:*\n` +
                            `📧 Login: ${email}\n` +
                            `🔑 Senha: ${password}\n\n` +
                            `📜 *Seu Contrato Assinado:* ${contractUrl}\n\n` +
                            `Acesse o portal para completar seu perfil: https://system.wisewolflanguage.com.br`;

                        const cleanPhone = phone.replace(/\D/g, '');
                        console.log(`✅ Instância: ${instanceName} | Destinatário: ${cleanPhone}`);

                        await whatsappService.sendText(
                            offerData.tenantId,
                            instanceName,
                            cleanPhone,
                            msg
                        );
                        console.log("✅ Boas-vindas enviadas com sucesso!");
                    } else {
                        console.error("❌ Erro ao buscar instância:", rpcError);
                    }
                }
            } catch (autoErr) {
                console.error("Erro na automação de boas-vindas:", autoErr);
            }

            setStep('SUCCESS');

        } catch (err: any) {
            console.error(err);
            let msg = err.message;
            if (msg.includes('already registered')) msg = "Este e-mail já está cadastrado.";
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    if (error) {
        return (
            <div className="min-h-screen bg-brand-surface-2 flex items-center justify-center p-4">
                <div className="bg-brand-surface p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-brand-text mb-2">Ops! Alguma coisa deu errado</h2>
                    <p className="text-brand-muted mb-6">{error}</p>
                    <button onClick={() => setError(null)} className="text-tenant-primary font-bold hover:underline">Tentar Novamente</button>
                </div>
            </div>
        );
    }

    if (!offerData) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-brand-muted" /></div>;
    }

    if (step === 'CONTRACT') {
        return (
            <div className="min-h-screen bg-gray-100 relative">
                <div className="fixed bottom-0 left-0 w-full p-6 bg-brand-surface border-t border-gray-200 z-50 shadow-2xl">
                    <div className="max-w-4xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
                        <div className="flex-1 space-y-2">
                            <div className="flex items-center gap-3">
                                <input 
                                    type="checkbox" 
                                    id="accept-contract"
                                    checked={contractAccepted}
                                    onChange={e => setContractAccepted(e.target.checked)}
                                    className="w-5 h-5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 transition-all cursor-pointer"
                                />
                                <label htmlFor="accept-contract" className="text-sm font-bold text-brand-text cursor-pointer select-none">
                                    Li e aceito os termos do contrato de prestação de serviço docente.
                                </label>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-brand-muted font-mono uppercase tracking-wider ml-8 bg-brand-surface-2 p-2 rounded-lg border border-brand-border">
                                <span>🔒 Assinatura vinculada ao IP: <span className="text-blue-500 font-bold">{userIp || 'Detectando...'}</span></span>
                                <span className="mx-2 opacity-30">|</span>
                                <span>🕒 Timestamp: <span className="text-brand-muted font-bold">{new Date().toLocaleString('pt-BR')}</span></span>
                            </div>
                        </div>

                        <div className="flex items-center gap-4 shrink-0">
                            <button onClick={() => setStep('FORM')} className="text-brand-muted text-sm font-black uppercase tracking-widest hover:text-brand-muted transition-colors px-4">
                                Corrigir Dados
                            </button>
                            <button
                                onClick={handleRegister}
                                disabled={loading || !contractAccepted}
                                className="bg-emerald-600 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-widest hover:bg-emerald-700 transition-all flex items-center gap-3 shadow-xl shadow-emerald-500/20 disabled:opacity-30 disabled:grayscale disabled:scale-95"
                            >
                                {loading ? <Loader2 className="animate-spin" /> : <><CheckCircle size={20} /> Assinar e Concluir</>}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="pb-32">
                    <TeacherContractDocument
                        teacherName={name}
                        teacherRG={rg}
                        teacherCPF={cpf}
                        teacherAddress={address}
                        teacherBirthDate={birthDate}
                        hourlyRate={offerData?.hourlyRate}
                        contractCity="Santa Isabel/SP"
                        contractDate={new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}
                        acceptedAt={contractAccepted ? new Date().toISOString() : undefined}
                        userIp={userIp}
                    />
                </div>
            </div>
        );
    }

    if (step === 'SUCCESS') {
        return (
            <div className="min-h-screen bg-brand-surface-2 flex items-center justify-center p-4 font-sans">
                <div className="bg-brand-surface p-8 rounded-3xl shadow-xl max-w-md w-full text-center animate-in zoom-in duration-300">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={40} className="text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-black text-brand-text mb-2">Boas-vindas, Professor(a)!</h2>
                    <p className="text-brand-muted mb-6 font-medium">
                        Seu cadastro foi realizado com sucesso. Você já pode acessar o portal com seu e-mail e senha.
                    </p>
                    <a href="/" className="block w-full px-8 py-4 bg-emerald-600 text-white rounded-xl font-bold uppercase tracking-widest hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-600/20">
                        Acessar Portal
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 py-12 px-4 font-sans">
            <div className="max-w-4xl mx-auto flex flex-col md:flex-row bg-brand-surface rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">

                {/* Left Side: Offer Details */}
                <div className="bg-[#002366] p-10 md:w-2/5 flex flex-col justify-between relative overflow-hidden text-white">
                    <div className="relative z-10">
                        <h1 className="text-3xl font-black uppercase tracking-tight mb-6">Portal do Professor</h1>

                        <div className="space-y-6">
                            <div className="bg-brand-surface/10 backdrop-blur-md p-6 rounded-2xl border border-white/10">
                                <h3 className="text-xs font-black uppercase tracking-widest text-blue-200 mb-1">Especialidade</h3>
                                <p className="text-2xl font-bold flex items-center gap-2">
                                    <Briefcase size={20} className="text-blue-300" /> {offerData.subject}
                                </p>
                            </div>

                            <div className="bg-brand-surface/10 backdrop-blur-md p-6 rounded-2xl border border-white/10">
                                <h3 className="text-xs font-black uppercase tracking-widest text-emerald-200 mb-1">Valor Hora/Aula</h3>
                                <p className="text-4xl font-black text-emerald-400 flex items-center gap-2">
                                    <span className="text-2xl text-emerald-300/80">R$</span> {offerData.hourlyRate.toFixed(2)}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="relative z-10 mt-12 bg-blue-900/50 p-6 rounded-2xl text-sm leading-relaxed text-blue-100">
                        <p>Complete seu cadastro ao lado para aceitar esta proposta e iniciar sua jornada conosco.</p>
                    </div>

                    {/* Decorative Circles */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/20 rounded-full blur-3xl translate-x-1/2 -translate-y-1/2"></div>
                    <div className="absolute bottom-0 left-0 w-40 h-40 bg-purple-500/20 rounded-full blur-3xl -translate-x-1/2 translate-y-1/2"></div>
                </div>

                {/* Right Side: Registration Form */}
                <div className="p-10 md:w-3/5 overflow-y-auto max-h-[90vh]">
                    <h2 className="text-2xl font-black text-brand-text flex items-center gap-2 mb-8">
                        <span className="w-2 h-8 bg-tenant-primary rounded-full" /> Criar sua Conta
                    </h2>

                    <form onSubmit={goToContract} className="space-y-6">
                        {/* Avatar Input (Simulated) */}
                        <div className="flex items-center gap-4 mb-6">
                            <div className="w-16 h-16 rounded-full bg-brand-surface-2 border-2 border-dashed border-brand-border flex items-center justify-center text-brand-muted overflow-hidden relative group cursor-pointer hover:border-tenant-primary hover:text-tenant-primary transition-colors">
                                {avatarUrl ? <img src={avatarUrl} className="w-full h-full object-cover" /> : <Camera size={24} />}
                            </div>
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wide text-brand-muted mb-1">Foto de Perfil</label>
                                <input
                                    type="text"
                                    placeholder="URL da foto (opcional)"
                                    value={avatarUrl}
                                    onChange={e => setAvatarUrl(e.target.value)}
                                    className="text-xs w-full bg-brand-surface-2 border-none rounded-lg px-3 py-2 text-brand-muted outline-none focus:ring-1 focus:ring-tenant-primary"
                                />
                            </div>
                        </div>

                        <div className="space-y-5">
                            <Input
                                label="Nome Completo"
                                value={name} onChange={e => setName(e.target.value)}
                                icon={<User size={16} />} required
                            />

                            <Input
                                label="E-mail de Acesso"
                                type="email"
                                value={email} onChange={e => setEmail(e.target.value)}
                                icon={<Mail size={16} />} required
                            />

                            <Input
                                label="Senha"
                                type="password"
                                value={password} onChange={e => setPassword(e.target.value)}
                                icon={<Lock size={16} />} required
                            />

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                <Input
                                    label="WhatsApp"
                                    value={phone} onChange={e => setPhone(e.target.value)}
                                    icon={<Phone size={16} />} required
                                />
                                <Input
                                    label="Chave Pix (Recebimentos)"
                                    value={pixKey} onChange={e => setPixKey(e.target.value)}
                                    icon={<Award size={16} />} required
                                />
                            </div>

                            <Input
                                label="Link da Sala (Meet/Zoom) - Opcional"
                                value={meetLink} onChange={e => setMeetLink(e.target.value)}
                                icon={<LinkIcon size={16} />}
                            />
                        </div>

                        {/* Personal Info for Contract */}
                        <div className="space-y-5 border-t border-brand-border pt-6">
                            <h3 className="text-xs font-black uppercase tracking-widest text-brand-muted mb-2 flex items-center gap-2">
                                <FileText size={14} /> Dados para Contrato
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                <Input
                                    label="CPF"
                                    value={cpf} onChange={(e: any) => setCpf(e.target.value)}
                                    required placeholder="000.000.000-00"
                                />
                                <Input
                                    label="RG"
                                    value={rg} onChange={(e: any) => setRg(e.target.value)}
                                    required placeholder="00.000.000-0"
                                />
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                <Input
                                    label="Data de Nascimento"
                                    type="date"
                                    value={birthDate} onChange={(e: any) => setBirthDate(e.target.value)}
                                    required
                                />
                                <Input
                                    label="Endereço Completo"
                                    value={address} onChange={(e: any) => setAddress(e.target.value)}
                                    required placeholder="Rua, Número, Bairro, CEP"
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-5 bg-tenant-primary hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2 mt-8 disabled:opacity-70 disabled:filter disabled:grayscale"
                        >
                            <>Revisar Contrato <ArrowRight size={18} /></>
                        </button>

                        <p className="text-center text-[10px] text-brand-muted font-medium mt-4">
                            Ao se cadastrar, você concorda com os termos de prestação de serviço docente.
                        </p>
                    </form>
                </div>
            </div>
        </div>
    );
};

const Input = ({ label, value, onChange, icon, type = "text", required = false }: any) => (
    <div className="space-y-1.5">
        <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted ml-1 flex items-center gap-1">
            {label} {required && <span className="text-red-400">*</span>}
        </label>
        <div className="relative group">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none group-focus-within:text-tenant-primary transition-colors">
                {icon}
            </div>
            <input
                type={type}
                required={required}
                value={value}
                onChange={onChange}
                className="w-full pl-11 pr-4 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary transition-all placeholder:text-brand-muted"
            />
        </div>
    </div>
);

export default TeacherOnboarding;
