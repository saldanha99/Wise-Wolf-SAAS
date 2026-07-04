import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { whatsappService } from '../services/whatsappService';
import { User, Mail, Lock, Phone, Award, CheckCircle, AlertCircle, ArrowRight, Loader2, DollarSign, Camera, Link as LinkIcon, Briefcase, FileText } from 'lucide-react';
import { TeacherContractDocument } from './TeacherContractDocument';

const TeacherOnboarding: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'MINDSET' | 'CONTRACT' | 'SUCCESS'>('OFFER');
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
        // Funil de contratação: antes do contrato, o candidato passa pelo funil de
        // mentalidade PJ (manifesto + quiz de compreensão obrigatório).
        setStep('MINDSET');
    };

    const handleRegister = async () => {
        if (!offerData || !contractAccepted) return;
        setLoading(true);
        setError(null);

        try {
            console.log("🚀 Enviando registro para Edge Function...");

            // Snapshot jurídico: gera o PDF do contrato exatamente como exibido/aceito.
            // Falha na geração NÃO trava o cadastro (o aceite digital continua registrado).
            let contractPdfBase64: string | null = null;
            try {
                const el = document.getElementById('teacher-contract-print');
                if (el) {
                    const html2pdf = (await import('html2pdf.js')).default;
                    const dataUri: string = await html2pdf()
                        .set({
                            margin: 8,
                            image: { type: 'jpeg', quality: 0.85 },
                            html2canvas: { scale: 1.5, useCORS: true },
                            jsPDF: { unit: 'mm', format: 'a4' },
                            pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
                        })
                        .from(el)
                        .outputPdf('datauristring');
                    contractPdfBase64 = String(dataUri).split(',')[1] || null;
                }
            } catch (pdfErr) {
                console.warn('⚠️ PDF do contrato não gerado (cadastro segue):', pdfErr);
            }

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
                    userIp: userIp || 'Pendente',
                    contractPdfBase64
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

    if (step === 'MINDSET') {
        return (
            <MindsetFunnel
                name={name}
                onBack={() => setStep('FORM')}
                onDone={() => setStep('CONTRACT')}
            />
        );
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

                <div className="pb-32" id="teacher-contract-print">
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

// ─────────────────────────────────────────────────────────────────────────────
// FUNIL DE MENTALIDADE PJ — o candidato só chega ao contrato depois de LER o
// manifesto e ACERTAR o quiz de compreensão. Objetivo: ele enxergar grandeza e
// seriedade — é o CNPJ DELE em jogo, ele é uma empresa prestando serviço.
// ─────────────────────────────────────────────────────────────────────────────
const QUIZ: { q: string; options: string[]; correct: number; explain: string }[] = [
    {
        q: '1. Qual é a natureza da sua relação com a Wise Wolf?',
        options: [
            'Serei funcionário CLT da escola',
            'Sou uma EMPRESA (meu CNPJ) prestando serviço para outra empresa — sem vínculo empregatício',
            'Serei estagiário com supervisão diária',
        ],
        correct: 1,
        explain: 'Exato: é contrato entre empresas. Seu CNPJ, sua reputação e sua autonomia — com liberdade e responsabilidade de dono.',
    },
    {
        q: '2. O que acontece quando você falta a uma aula?',
        options: [
            'Nada, é só avisar depois',
            'Perco o turbo por 30 dias (volto ao valor base de R$ 8,00/aula), a aula precisa de reposição e o aluno pode ser transferido se virar rotina',
            'Recebo advertência por escrito',
        ],
        correct: 1,
        explain: 'Isso. Assiduidade é o coração do negócio: falta derruba seu ganho, gera reposição e, se repetir, o aluno troca de professor.',
    },
    {
        q: '3. Como uma aula conta para o seu pagamento?',
        options: [
            'Basta eu lançar no sistema',
            'O aluno confirma a presença pelo WhatsApp; se a resposta dele divergir do meu lançamento, o pagamento daquela aula fica retido até a coordenação resolver',
            'A escola confia sem verificação',
        ],
        correct: 1,
        explain: 'Correto: temos verificação antifraude com o aluno. Lançamento honesto + aula dada = pagamento garantido, sem stress.',
    },
    {
        q: '4. Como funciona uma saída correta da Wise Wolf?',
        options: [
            'Posso simplesmente parar de dar aula quando quiser',
            'Aviso com 30 dias, ajudo na transição dos alunos e recebo o último fechamento com bônus de 10%; sumir sem aviso gera multa contratual',
            'Preciso pedir demissão por carta registrada',
        ],
        correct: 1,
        explain: 'Isso! Saída elegante é premiada; abandono é penalizado. Profissional de verdade fecha ciclos direito.',
    },
    {
        q: '5. O que você emite todo mês depois de receber o repasse?',
        options: [
            'Nada, o Pix já resolve',
            'Um recibo de papel assinado',
            'A NFS-e do meu CNPJ (emissor nacional gov.br/nfse ou app MEI), no valor do fechamento, anexada na plataforma',
        ],
        correct: 2,
        explain: 'Perfeito: empresa fatura com nota. É sua obrigação fiscal como PJ — e leva menos de 5 minutos no app MEI.',
    },
];

const MANIFESTO: { emoji: string; title: string; text: string }[] = [
    { emoji: '🏢', title: 'Você é uma empresa', text: 'A Wise Wolf não contrata funcionários — fecha parceria com EMPRESAS. É o seu CNPJ que assina, fatura e constrói reputação aqui. Aja como dono, porque você é.' },
    { emoji: '📈', title: 'Seu ganho cresce com a sua seriedade', text: 'Todo mundo começa com poucos alunos. Quem é assíduo e entrega qualidade recebe mais alunos e, a partir de 10 alunos ativos + 30 dias sem falta, destrava o turbo (R$ 9,50/10,50 por aula) e cresce rápido. Quem falta, encolhe.' },
    { emoji: '🛡️', title: 'Aqui tudo é verificado', text: 'Cada aula é confirmada com o aluno por WhatsApp. Lançamento honesto é inegociável — divergência trava o pagamento e chama a coordenação.' },
    { emoji: '📅', title: 'Suas obrigações de rotina', text: 'Lançar a aula no mesmo dia, manter o calendário de disponibilidade sempre atualizado, repor falta combinando com o aluno e emitir a NFS-e após cada repasse.' },
    { emoji: '🎓', title: 'O aluno é sagrado', text: 'Aluno que fica pulando de professor em professor desiste do inglês. Sua constância é o que segura o sonho dele — e a sua carteira.' },
    { emoji: '🤝', title: 'Saída com elegância', text: 'Um dia você pode querer seguir outro caminho — sem problema. Avise com 30 dias, ajude na transição dos alunos e receba seu último fechamento com bônus de 10%. Sumir sem aviso gera multa contratual e queima sua reputação.' },
];

const MindsetFunnel: React.FC<{ name: string; onBack: () => void; onDone: () => void }> = ({ name, onBack, onDone }) => {
    const [answers, setAnswers] = useState<(number | null)[]>(QUIZ.map(() => null));
    const [checked, setChecked] = useState(false);
    const allAnswered = answers.every(a => a !== null);
    const allCorrect = answers.every((a, i) => a === QUIZ[i].correct);

    const handleCheck = () => {
        setChecked(true);
        if (answers.every((a, i) => a === QUIZ[i].correct)) {
            setTimeout(onDone, 900);
        }
    };

    return (
        <div className="min-h-screen bg-brand-surface-2 font-sans">
            <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12 pb-32">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-accent mb-2">Etapa 2 de 3 · Mentalidade Wise Wolf</p>
                <h1 className="text-2xl sm:text-3xl font-black text-brand-text leading-tight">
                    {name ? `${name.split(' ')[0]}, antes` : 'Antes'} de assinar: aqui você não é funcionário. <span className="text-brand-accent">Você é uma empresa.</span>
                </h1>
                <p className="text-sm text-brand-muted mt-2 leading-relaxed">
                    Leia com atenção — o quiz no final é obrigatório e só libera o contrato com todas as respostas certas.
                </p>

                <div className="space-y-3 mt-8">
                    {MANIFESTO.map(m => (
                        <div key={m.title} className="bg-brand-surface border border-brand-border rounded-2xl p-5 flex items-start gap-4">
                            <span className="text-2xl shrink-0">{m.emoji}</span>
                            <div>
                                <p className="font-black text-brand-text text-sm uppercase tracking-wide">{m.title}</p>
                                <p className="text-sm text-brand-muted mt-1 leading-relaxed">{m.text}</p>
                            </div>
                        </div>
                    ))}
                </div>

                <h2 className="text-lg font-black text-brand-text mt-10 mb-4">✅ Quiz de compreensão</h2>
                <div className="space-y-6">
                    {QUIZ.map((item, qi) => {
                        const chosen = answers[qi];
                        const isRight = checked && chosen === item.correct;
                        const isWrong = checked && chosen !== null && chosen !== item.correct;
                        return (
                            <div key={qi} className={`bg-brand-surface border rounded-2xl p-5 transition-colors ${isWrong ? 'border-red-500/50' : isRight ? 'border-emerald-500/50' : 'border-brand-border'}`}>
                                <p className="font-bold text-sm text-brand-text mb-3">{item.q}</p>
                                <div className="space-y-2">
                                    {item.options.map((opt, oi) => (
                                        <button
                                            key={oi}
                                            type="button"
                                            onClick={() => { const next = [...answers]; next[qi] = oi; setAnswers(next); setChecked(false); }}
                                            className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all ${chosen === oi
                                                ? 'border-brand-accent bg-brand-accent/10 text-brand-text font-bold'
                                                : 'border-brand-border text-brand-muted hover:border-brand-accent/40'}`}
                                        >
                                            {opt}
                                        </button>
                                    ))}
                                </div>
                                {isRight && <p className="text-xs text-emerald-600 font-bold mt-3">✔ {item.explain}</p>}
                                {isWrong && <p className="text-xs text-red-500 font-bold mt-3">✖ Ainda não — releia os cards acima e tente de novo.</p>}
                            </div>
                        );
                    })}
                </div>

                <div className="mt-8 flex items-center gap-3">
                    <button onClick={onBack} className="text-brand-muted text-xs font-black uppercase tracking-widest hover:text-brand-text px-4 py-4">← Voltar</button>
                    <button
                        onClick={handleCheck}
                        disabled={!allAnswered}
                        className="flex-1 py-4 rounded-2xl bg-brand-accent text-white font-black uppercase tracking-widest text-sm hover:bg-brand-accent-hover transition-all disabled:opacity-30"
                    >
                        {checked && allCorrect ? 'Perfeito! Abrindo o contrato…' : 'Conferir respostas'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TeacherOnboarding;
