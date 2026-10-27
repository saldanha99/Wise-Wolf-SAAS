import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User, Mail, Lock, Phone, Award, CheckCircle, AlertCircle, ArrowRight, Loader2, DollarSign, Camera, Link as LinkIcon, Briefcase, FileText } from 'lucide-react';
import { TeacherContractDocument, getTeacherContractReadiness } from './TeacherContractDocument';
import { getSchoolContractIdentity, type SchoolInfo } from './ContractDocument';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';
import { contractIncludesLessonRecording } from '../lib/contractTerms';
import { offeredContractTermsVersion } from '../services/contractTermsService';
import { openGoogleAuthorization } from '../lib/googleAuthorizationWindow';
import { parseTeacherProviderIdentity } from '../lib/teacherProviderIdentity';

const TeacherOnboarding: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'MINDSET' | 'CONTRACT' | 'SUCCESS'>('OFFER');
    const [error, setError] = useState<string | null>(null);
    const [contractError, setContractError] = useState<string | null>(null);
    const [offerData, setOfferData] = useState<any>(null);

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');
    const [pixKey, setPixKey] = useState('');
    const [meetLink, setMeetLink] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [googleProof, setGoogleProof] = useState('');
    const [googleAuthorizationUrl, setGoogleAuthorizationUrl] = useState('');
    const [googleEmail, setGoogleEmail] = useState('');
    const [googleBusy, setGoogleBusy] = useState(false);
    const [googleError, setGoogleError] = useState('');

    // New Fields for Contract
    const [rg, setRg] = useState('');
    const [cpf, setCpf] = useState('');
    const [address, setAddress] = useState('');
    const [birthDate, setBirthDate] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [cnpj, setCnpj] = useState('');
    const [companyAddress, setCompanyAddress] = useState('');
    const [userIp, setUserIp] = useState('');
    const [contractAccepted, setContractAccepted] = useState(false);

    useEffect(() => {
        // 1. Decode Query Params
        const params = new URLSearchParams(window.location.search);
        const encodedOffer = params.get('offer');

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (encodedOffer && UUID_RE.test(encodedOffer.trim())) {
            // Caminho seguro: offer_id (UUID) → valor por aula AUTORITATIVO do servidor.
            (async () => {
                try {
                    const payload = await tenantLegalAssetsService.teacherOffer(encodedOffer.trim());
                    if (!payload || payload.error) throw new Error('offer_unavailable');
                    setOfferData(payload);
                } catch {
                    setError("Link de convite inválido, expirado ou já utilizado. Solicite um novo.");
                }
            })();
        } else if (encodedOffer) {
            setError("Este convite antigo não possui validação server-side. Solicite um novo link seguro à escola.");
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

    const schoolInfo = offerData?.schoolInfo && typeof offerData.schoolInfo === 'object'
        ? offerData.schoolInfo as SchoolInfo
        : null;
    const schoolIdentity = getSchoolContractIdentity(schoolInfo);
    const teacherContractReadiness = getTeacherContractReadiness(schoolInfo, offerData?.hourlyRate);
    // Versão do contrato que a escola do convite oferece (edge
    // tenant-legal-assets): esta tela MOSTRA, congela no PDF e ENVIA a mesma.
    // Só a escola que decidiu registrar as aulas oferece a Cláusula 11ª.
    const contractTermsVersion = offeredContractTermsVersion('TEACHER', offerData);
    const providerIdentity = { companyName, cnpj, companyAddress, representativeCpf: cpf, representativeHasAuthority: true };
    const providerReady = contractTermsVersion < 3 || Boolean(parseTeacherProviderIdentity(providerIdentity));
    useEffect(() => { setContractAccepted(false); }, [companyName, cnpj, companyAddress, cpf, name, contractTermsVersion]);
    const withLessonRecording = contractIncludesLessonRecording('TEACHER', contractTermsVersion);
    const googleAccountRequired = offerData?.googleAccountRequired === true;
    const offerId = new URLSearchParams(window.location.search).get('offer') || '';

    const startGoogleConfirmation = async () => {
        setGoogleBusy(true); setGoogleError(''); setGoogleEmail('');
        setGoogleProof(''); setGoogleAuthorizationUrl('');
        try {
            const { result, opened } = await openGoogleAuthorization(async () => {
                const { data, error } = await supabase.functions.invoke('google-meet', {
                    body: { action: 'teacher_invite_google_start', offerId },
                });
                if (error || !data?.proof || !data?.authorization_url) throw new Error();
                return data as { proof: string; authorization_url: string };
            });
            setGoogleProof(result.proof);
            if (!opened) setGoogleAuthorizationUrl(result.authorization_url);
        } catch {
            setGoogleError('Não foi possível iniciar a confirmação. Confira o convite e tente novamente.');
        } finally { setGoogleBusy(false); }
    };

    useEffect(() => {
        if (!googleProof || googleEmail) return;
        const refresh = async () => {
            if (document.visibilityState !== 'visible') return;
            try {
                const { data, error } = await supabase.functions.invoke('google-meet', {
                    body: { action: 'teacher_invite_google_status', offerId, proof: googleProof },
                });
                if (!error && data?.verified && data?.email) {
                    setGoogleEmail(data.email); setGoogleError('');
                }
            } catch { /* A conferência manual continua disponível. */ }
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [googleProof, googleEmail, offerId]);

    const checkGoogleConfirmation = async () => {
        if (!googleProof) return;
        setGoogleBusy(true); setGoogleError('');
        try {
            const { data, error } = await supabase.functions.invoke('google-meet', {
                body: { action: 'teacher_invite_google_status', offerId, proof: googleProof },
            });
            if (error || !data?.verified || !data?.email) {
                throw new Error('Ainda não recebemos a confirmação do Google. Termine o login na outra aba e tente novamente.');
            }
            setGoogleEmail(data.email);
        } catch (error) {
            setGoogleError((error as Error).message);
        } finally { setGoogleBusy(false); }
    };

    const openContract = async () => {
        const offerId = new URLSearchParams(window.location.search).get('offer');
        if (!offerId) {
            setError('Link de convite inválido.');
            return;
        }
        try {
            const refreshedOffer = await tenantLegalAssetsService.teacherOffer(offerId);
            setOfferData(refreshedOffer);
            setStep('CONTRACT');
        } catch {
            setError('Não foi possível liberar a assinatura privada. Solicite um novo convite.');
        }
    };

    const goToContract = (e: React.FormEvent) => {
        e.preventDefault();
        if (!providerReady) { setContractError('Confira a razão social, o CNPJ, o endereço da empresa e o CPF do representante antes de continuar.'); return; }
        if (googleAccountRequired && !googleEmail) {
            setGoogleError('Confirme primeiro a conta Google com que você entrará nas aulas.');
            return;
        }
        if (!teacherContractReadiness.isReady || !providerReady) {
            setContractError(`A escola precisa configurar ${teacherContractReadiness.missingFields.join(', ')} antes de emitir este contrato.`);
            return;
        }
        setContractError(null);
        // Funil de contratação: antes do contrato, o candidato passa pelo funil de
        // mentalidade PJ (manifesto + quiz de compreensão obrigatório).
        setStep('MINDSET');
    };

    const handleRegister = async () => {
        if (!offerData || !contractAccepted) return;
        if (!providerReady) { setContractError('Confira os dados da empresa e do representante antes de assinar.'); setContractAccepted(false); return; }
        if (googleAccountRequired && !googleEmail) {
            setContractError('Confirme a conta Google das aulas antes de assinar.');
            setStep('FORM');
            return;
        }
        if (!teacherContractReadiness.isReady) {
            setContractError(`A assinatura foi bloqueada porque faltam: ${teacherContractReadiness.missingFields.join(', ')}.`);
            setContractAccepted(false);
            return;
        }
        setLoading(true);
        setError(null);

        try {
            console.log("🚀 Enviando registro para Edge Function...");

            // Snapshot jurídico: gera o PDF exatamente como exibido. Sem a versão
            // imutável, o cadastro não prossegue e nunca aceita um contrato mutável.
            let contractPdfBase64: string | null = null;
            try {
                const el = document.getElementById('teacher-contract-print');
                if (!el) throw new Error('Documento do contrato indisponível para captura.');
                const html2pdf = (await import('html2pdf.js')).default;
                // O Safari do iPhone recusa canvas acima de ~16,7 milhões de pixels,
                // e o contrato inteiro na largura do celular passa disso com escala 1,5.
                const capturedArea = Math.max(1, el.scrollWidth * el.scrollHeight);
                const captureScale = Math.min(1.5, Math.sqrt(15_000_000 / capturedArea));
                // O plugin aceita `pagebreak` em runtime, mas a declaração de tipos
                // publicada pelo pacote ainda não expõe essa opção.
                const pdfOptions = {
                        margin: 8,
                        image: { type: 'jpeg', quality: 0.85 },
                        html2canvas: { scale: captureScale, useCORS: true },
                        jsPDF: { unit: 'mm', format: 'a4' },
                        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
                    };
                const dataUri: string = await html2pdf()
                    .set(pdfOptions as any)
                    .from(el)
                    .outputPdf('datauristring');
                contractPdfBase64 = String(dataUri).split(',')[1] || null;
                if (!contractPdfBase64) throw new Error('PDF jurídico vazio.');
            } catch (pdfErr) {
                console.error('PDF jurídico do contrato não foi gerado:', pdfErr);
                throw new Error('Não foi possível gerar o PDF do contrato neste aparelho. Tente novamente; se persistir, abra o convite em outro navegador.');
            }

            const { data, error: fnError } = await supabase.functions.invoke('register-teacher', {
                body: {
                    email,
                    password,
                    name,
                    phone: phone.replace(/\D/g, ''), // Send clean phone
                    pixKey,
                    meetLink,
                    googleIdentityProof: googleProof,
                    avatar: avatarUrl,
                    offerPayload: new URLSearchParams(window.location.search).get('offer'),
                    rg,
                    cpf: cpf.replace(/\D/g, ''),
                    address,
                    birthDate,
                    contractAccepted: true,
                    rateUnit: 'PER_LESSON',
                    // Versão do texto que esta tela mostrou e o PDF congelou
                    // (a que a escola do convite oferece). O servidor recusa
                    // (409) a página antiga, sem a versão, e a desatualizada.
                    contractTermsVersion,
                    ...(contractTermsVersion >= 3 ? { providerIdentity } : {}),
                    acceptedAt: new Date().toISOString(),
                    userIp: userIp || 'Pendente',
                    contractPdfBase64
                }
            });

            if (fnError) {
                if (fnError.context instanceof Response && fnError.context.status === 409) {
                    let serverMessage = '';
                    try { serverMessage = String((await fnError.context.json())?.error || ''); } catch { /* resposta sem JSON */ }
                    throw new Error(serverMessage || 'O contrato, o convite ou a confirmação Google mudou. Recarregue a página e tente novamente.');
                }
                throw new Error(fnError.message || "Erro ao conectar com o servidor.");
            }
            if (data?.error) throw new Error(data.error);

            // A função register-teacher já consome o convite e envia a mensagem
            // server-side. Repetir o consumo aqui fazia a tela acusar erro depois
            // de o professor já ter sido criado com sucesso.

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
                schoolName={schoolIdentity.name}
                onBack={() => setStep('FORM')}
                onDone={() => void openContract()}
            />
        );
    }

    if (step === 'CONTRACT') {
        return (
            <div className="min-h-screen bg-gray-100 relative">
                <div className="fixed bottom-0 left-0 z-50 max-h-[48dvh] w-full overflow-y-auto border-t border-gray-200 bg-brand-surface p-3 shadow-2xl sm:p-6">
                    <div className="max-w-4xl mx-auto flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 md:gap-6">
                        <div className="flex-1 space-y-2">
                            {!teacherContractReadiness.isReady && (
                                <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-900">
                                    Assinatura bloqueada: a escola precisa configurar {teacherContractReadiness.missingFields.join(', ')}.
                                </div>
                            )}
                            <div className="flex items-center gap-3">
                                <input 
                                    type="checkbox" 
                                    id="accept-contract"
                                    checked={contractAccepted}
                                    disabled={!teacherContractReadiness.isReady}
                                    onChange={e => setContractAccepted(e.target.checked)}
                                    className="w-5 h-5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 transition-all cursor-pointer"
                                />
                                <label htmlFor="accept-contract" className="text-sm font-bold text-brand-text cursor-pointer select-none">
                                    {withLessonRecording
                                        ? 'Li e aceito os termos do contrato de prestação de serviço docente, inclusive a Cláusula 11ª (registro das aulas: transcrição e anotações automáticas do Google Meet, sem vídeo).'
                                        : 'Li e aceito os termos do contrato de prestação de serviço docente.'}
                                </label>
                            </div>
                            <div className="ml-0 flex flex-wrap items-center gap-2 rounded-lg border border-brand-border bg-brand-surface-2 p-2 text-[10px] font-mono uppercase tracking-wider text-brand-muted sm:ml-8">
                                <span>🔒 Assinatura vinculada ao IP: <span className="text-blue-500 font-bold">{userIp || 'Detectando...'}</span></span>
                                <span className="mx-2 opacity-30">|</span>
                                <span>🕒 Timestamp: <span className="text-brand-muted font-bold">{new Date().toLocaleString('pt-BR')}</span></span>
                            </div>
                        </div>

                        <div className="flex w-full flex-col-reverse items-stretch gap-2 shrink-0 sm:flex-row sm:items-center md:w-auto md:gap-4">
                            <button onClick={() => setStep('FORM')} className="w-full px-4 py-3 text-sm font-black uppercase tracking-widest text-brand-muted transition-colors hover:text-brand-text sm:w-auto">
                                Corrigir Dados
                            </button>
                            <button
                                onClick={handleRegister}
                                disabled={loading || !teacherContractReadiness.isReady || !providerReady || !contractAccepted}
                                className="flex w-full items-center justify-center gap-3 rounded-2xl bg-emerald-600 px-6 py-4 font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-500/20 transition-all hover:bg-emerald-700 disabled:scale-95 disabled:grayscale disabled:opacity-30 sm:w-auto sm:px-10"
                            >
                                {loading ? <Loader2 className="animate-spin" /> : <><CheckCircle size={20} /> Assinar e Concluir</>}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="pb-[48dvh] sm:pb-48" id="teacher-contract-print">
                    <TeacherContractDocument
                        teacherName={name}
                        teacherRG={rg}
                        teacherCPF={cpf}
                        teacherAddress={address}
                        teacherBirthDate={birthDate}
                        school={schoolInfo}
                        hourlyRate={offerData?.hourlyRate}
                        rateUnit="PER_LESSON"
                        termsVersion={contractTermsVersion}
                        providerIdentity={providerIdentity}
                        contractDate={new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}
                        acceptedAt={teacherContractReadiness.isReady && contractAccepted ? new Date().toISOString() : undefined}
                        userIp={userIp}
                        displayMode="responsive"
                        showPrintButton={false}
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
        <div className="min-h-screen bg-linear-to-br from-slate-50 to-indigo-50 py-12 px-4 font-sans">
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
                                <h3 className="text-xs font-black uppercase tracking-widest text-emerald-200 mb-1">Valor por aula</h3>
                                <p className="text-4xl font-black text-emerald-400 flex items-center gap-2">
                                    <span className="text-2xl text-emerald-300/80">R$</span> {Number(offerData.hourlyRate || 0).toFixed(2).replace('.', ',')}
                                </p>
                                <p className="text-sm text-emerald-200 mt-2">Por aula de 30 minutos</p>
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
                        {!teacherContractReadiness.isReady && (
                            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
                                <p className="font-black uppercase tracking-wide">Contrato ainda não disponível</p>
                                <p className="mt-1">A escola deve configurar {teacherContractReadiness.missingFields.join(', ')} e gerar um novo convite seguro.</p>
                            </div>
                        )}
                        {contractError && (
                            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-800">
                                {contractError}
                            </div>
                        )}
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
                                    className="text-xs w-full bg-brand-surface-2 border-none rounded-lg px-3 py-2 text-brand-muted outline-hidden focus:ring-1 focus:ring-tenant-primary"
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
                            {googleAccountRequired && (
                                <div data-tour="teacher-invite-google" className="rounded-2xl border-2 border-indigo-300 bg-indigo-50 p-5 text-sm text-slate-800">
                                    <p className="font-black">Obrigatório: confirme a conta Google das suas aulas</p>
                                    <p className="mt-2 leading-relaxed">Escolha a <strong>sua conta Google com que você entrará nas reuniões do Google Meet</strong>. Ela será vinculada ao seu cadastro para você entrar como coanfitrião nas salas oficiais da escola. Pode ser diferente do e-mail de acesso ao portal. Não use a conta central da escola nem a de outra pessoa.</p>
                                    {googleEmail && <p className="mt-3 font-bold text-emerald-700">Conta confirmada: {googleEmail}</p>}
                                    {!googleEmail ? (
                                        <div className="mt-3 flex flex-wrap items-center gap-3">
                                            <button type="button" disabled={googleBusy} onClick={() => void startGoogleConfirmation()} className="rounded-xl bg-indigo-700 px-4 py-3 font-bold text-white disabled:opacity-50">Confirmar minha conta Google</button>
                                            {googleAuthorizationUrl && <a href={googleAuthorizationUrl} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-indigo-700 px-4 py-3 font-bold text-white">Abrir login Google ↗</a>}
                                            {googleProof && <button type="button" disabled={googleBusy} onClick={() => void checkGoogleConfirmation()} className="font-bold text-indigo-700 underline">Já confirmei</button>}
                                        </div>
                                    ) : (
                                        <button type="button" disabled={googleBusy} onClick={() => void startGoogleConfirmation()} className="mt-2 font-bold text-indigo-700 underline">Usar outra conta ou confirmar novamente</button>
                                    )}
                                    {googleError && <p role="alert" className="mt-3 font-bold text-red-700">{googleError}</p>}
                                    {googleAuthorizationUrl && <p className="mt-2 text-sm font-bold text-amber-800">O navegador bloqueou a nova aba. Toque em “Abrir login Google”.</p>}
                                    {googleProof && !googleEmail && <p role="status" className="mt-2 text-sm">Conclua o login na aba do Google. Ao voltar, conferimos a confirmação automaticamente.</p>}
                                    <p className="mt-2 text-xs text-slate-600">O link do Google dura 10 minutos. Não compartilhe sua senha ou código com a escola.</p>
                                </div>
                            )}
                        </div>

                        {/* Personal Info for Contract */}
                        <div className="space-y-5 border-t border-brand-border pt-6">
                            {contractTermsVersion >= 3 && <div data-tour="teacher-provider-identity" className="space-y-4 rounded-xl border border-brand-border p-4">
                                <p className="text-sm font-bold">Empresa que presta os serviços</p>
                                <Input label="Razão social / nome empresarial" value={companyName} onChange={e => setCompanyName(e.target.value)} required maxLength={160} />
                                <Input label="CNPJ da empresa" value={cnpj} onChange={e => setCnpj(e.target.value.toUpperCase())} required maxLength={18} />
                                <Input label="Endereço completo da empresa" value={companyAddress} onChange={e => setCompanyAddress(e.target.value)} required maxLength={300} />
                                <p className="text-xs text-brand-muted">Ao assinar, você declara poderes para representar essa empresa. Confira os dados antes de concluir.</p>
                            </div>}
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
                            disabled={loading || !teacherContractReadiness.isReady}
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

const Input = ({ label, icon, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: React.ReactNode }) => {
    const id = React.useId();
    return (
    <div className="space-y-1.5">
        <label htmlFor={id} className="text-[10px] font-black uppercase tracking-widest text-brand-muted ml-1 flex items-center gap-1">
            {label} {props.required && <span className="text-red-400">*</span>}
        </label>
        <div className="relative group">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none group-focus-within:text-tenant-primary transition-colors">
                {icon}
            </div>
            <input
                {...props}
                id={id}
                className="w-full pl-11 pr-4 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-hidden focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary transition-all placeholder:text-brand-muted"
            />
        </div>
    </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Orientação pré-contratual e perguntas de compreensão; sem renúncia de direitos.
// ─────────────────────────────────────────────────────────────────────────────
// Orientação de leitura: não substitui o contrato nem decide a natureza da relação.
const QUIZ: { q: string; options: string[]; correct: number; explain: string }[] = [
    {
        q: '1. O que a assinatura de um contrato por PJ demonstra?',
        options: ['Impede qualquer reconhecimento de emprego', 'Documenta o acordo proposto; a natureza da relação também depende de como o trabalho acontece', 'Dispensa a identificação da empresa'],
        correct: 1,
        explain: 'O texto, o cadastro e a execução precisam ser coerentes. Direitos indisponíveis não são renunciados no cadastro.',
    },
    {
        q: '2. Antes de assumir um novo atendimento, o que você precisa conferir?',
        options: ['Só o nome do aluno', 'Objeto, disponibilidade, agenda, remuneração e condições antes do aceite', 'Nada, todo aluno já está aceito pelo contrato geral'],
        correct: 1,
        explain: 'Aceite o compromisso depois de conferir as condições. Uma proposta não aceita não é uma aula confirmada.',
    },
    {
        q: '3. Como tratar uma divergência sobre uma aula?',
        options: ['Inventar um registro para encerrar a pendência', 'Preservar os registros, informar a escola e permitir a apuração das informações', 'Considerar que o silêncio do aluno prova tudo'],
        correct: 1,
        explain: 'Uma reclamação ou um registro isolado precisa ser examinado com as demais informações.',
    },
    {
        q: '4. Como comunicar o encerramento da prestação?',
        options: ['Parar sem informar a escola', 'Comunicar por escrito, observar o prazo e as hipóteses de redução ou saída antecipada do contrato e organizar a transição', 'Permanecer até a escola encontrar substituto, sem limite'],
        correct: 1,
        explain: 'A saída tem data e deve seguir o instrumento aceito. Não depende de permanecer indefinidamente ou de aceitar novos alunos.',
    },
    {
        q: '5. Como cumprir as obrigações fiscais da empresa?',
        options: ['O PIX substitui a nota fiscal', 'Todo professor precisa ser MEI', 'Manter cadastro regular e emitir a nota conforme a legislação e o regime aplicável'],
        correct: 2,
        explain: 'O enquadramento e o emissor da nota dependem da situação fiscal da empresa.',
    },
];

const MANIFESTO: { emoji: string; title: string; text: string }[] = [
    { emoji: '🏢', title: 'Confira as partes', text: 'Verifique quem contrata, quem presta o serviço e quem representa a empresa. A proposta de contratação por PJ não contém garantia sobre a natureza jurídica da relação na prática.' },
    { emoji: '📅', title: 'Proposta e compromisso', text: 'Informe sua disponibilidade e confira as condições antes de assumir o atendimento. Depois do aceite, cumpra as aulas combinadas e comunique impedimentos pelo canal oficial.' },
    { emoji: '🛡️', title: 'Registros verdadeiros', text: 'Registre o atendimento como ocorreu. Divergências são examinadas com as informações das partes; o cadastro não autoriza lançamento fictício nem substitui a apuração.' },
    { emoji: '📈', title: 'Confira sua remuneração', text: 'Leia o valor por aula e as condições comerciais do documento. Eventuais bonificações seguem o instrumento ou a política aplicável; esta orientação não cria novas faixas ou promessas de ganho.' },
    { emoji: '🤝', title: 'Você pode encerrar', text: 'Comunique a saída por escrito e confira o prazo contratual, as possibilidades de acordo e os motivos que possam justificar uma saída antecipada. A transição preserva o atendimento e a remuneração devida, sem permanência indefinida.' },
    { emoji: '🧾', title: 'Cadastro fiscal', text: 'Mantenha a identificação da empresa e emita os documentos fiscais conforme a legislação aplicável. Em caso de dúvida sobre enquadramento, confira com seu contador.' },
];

const MindsetFunnel: React.FC<{ name: string; schoolName: string; onBack: () => void; onDone: () => void }> = ({ name, schoolName, onBack, onDone }) => {
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
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-accent mb-2">Etapa 2 de 3 · Mentalidade profissional · {schoolName}</p>
                <h1 className="text-2xl sm:text-3xl font-black text-brand-text leading-tight">
                    {name ? `${name.split(' ')[0]}, conheça` : 'Conheça'} a proposta antes de assinar: <span className="text-brand-accent">autonomia, atendimento e transição.</span>
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
