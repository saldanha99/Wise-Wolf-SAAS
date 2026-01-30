import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { whatsappService } from '../services/whatsappService';
import { ContractDocument } from './ContractDocument';
import ContractModal from './ContractModal';
import { useReactToPrint } from 'react-to-print';
import { User, Mail, Lock, Phone, MapPin, CheckCircle, AlertCircle, ArrowRight, Loader2, QrCode, Barcode, CreditCard, Calendar, ShieldCheck, Download } from 'lucide-react';

const PublicRegistration: React.FC = () => {
    const [loading, setLoading] = useState(false);
    // Steps: FORM -> CONTRACT -> SUCCESS
    const [step, setStep] = useState<'FORM' | 'CONTRACT' | 'SUCCESS'>('FORM');
    const [error, setError] = useState<string | null>(null);
    const [contractData, setContractData] = useState<any>(null);
    // Signature Data for PDF
    const [signatureData, setSignatureData] = useState<{ acceptedAt: string; ip: string; subId: string } | null>(null);
    const [signedPdfUrl, setSignedPdfUrl] = useState<string>('');

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState(''); // WhatsApp
    const [cpf, setCpf] = useState('');
    const [postalCode, setPostalCode] = useState('');
    const [address, setAddress] = useState('');
    const [addressNumber, setAddressNumber] = useState('');

    // Payment Logic
    const [billingType, setBillingType] = useState<'PIX' | 'BOLETO' | 'CREDIT_CARD'>('PIX');

    // Credit Card Fields
    const [ccName, setCcName] = useState('');
    const [ccNumber, setCcNumber] = useState('');
    const [ccExpiry, setCcExpiry] = useState(''); // MM/YYYY
    const [ccCcv, setCcCcv] = useState('');

    // Contract Printing Logic (Must be after state declarations)
    const contractRef = useRef(null);
    const handlePrintContract = useReactToPrint({
        content: () => contractRef.current,
        documentTitle: `Contrato_WiseWolf_${name ? name.replace(/\s+/g, '_') : 'Aluno'}`,
    });



    useEffect(() => {
        // Decode Query Params
        const params = new URLSearchParams(window.location.search);
        const encodedData = params.get('data');
        if (encodedData) {
            try {
                const jsonStr = atob(encodedData);
                const data = JSON.parse(jsonStr);
                // Schema: { unitId, value, planDuration, classesPerWeek, dueDay }
                setContractData(data);
            } catch (e) {
                setError("Link de matrícula inválido ou expirado.");
            }
        } else {
            setError("Link de matrícula inválido. Solicite um novo link à escola.");
        }
    }, []);

    const handleRegister = async (signatureDataObj?: { type: 'DIGITAL' | 'UPLOAD_SIG' | 'UPLOAD_DOC', url?: string }) => {
        if (!contractData) return;
        setLoading(true);
        setError(null);

        try {
            // Map numeric duration to Enum
            const durationEnum = contractData.planDuration === 12 ? 'ANNUAL' : contractData.planDuration === 6 ? 'SEMESTER' : 'RECURRENT';

            // Validate Credit Card if selected
            let creditCardData = null;
            if (billingType === 'CREDIT_CARD') {
                if (!ccName || !ccNumber || !ccExpiry || !ccCcv) {
                    throw new Error("Preencha todos os dados do cartão de crédito.");
                }
                const [expMonth, expYear] = ccExpiry.split('/');
                if (!expMonth || !expYear || expMonth.length !== 2 || expYear.length !== 4) {
                    throw new Error("Data de validade inválida. Use o formato MM/AAAA (ex: 12/2030).");
                }

                creditCardData = {
                    holderName: ccName,
                    number: ccNumber.replace(/\D/g, ''),
                    expiryMonth: expMonth,
                    expiryYear: expYear,
                    ccv: ccCcv
                };
            }

            console.log("🚀 Iniciando processo de matrícula...");

            // 1. Create Auth User
            const { data: authData, error: authError } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: { full_name: name, role: 'STUDENT', tenant_id: contractData.unitId }
                }
            });

            if (authError) throw authError;
            if (!authData.user) throw new Error("Erro ao criar usuário.");

            const userId = authData.user.id;

            // 2. Create Profile (with contract_accepted = true)
            const { error: profileError } = await supabase.from('profiles').upsert({
                id: userId,
                email: email,
                full_name: name,
                role: 'STUDENT',
                tenant_id: contractData.unitId,
                phone: phone,
                cpf: cpf.replace(/\D/g, ''),
                postal_code: postalCode,
                address: address,
                address_number: addressNumber,
                status_financial: 'PENDING',
                monthly_fee: contractData.value,
                due_day: contractData.dueDay,
                module: 'General', // Default module
                contract_accepted: true,
                documentation_status: 'APPROVED', // Auto-approve documentation
                accepted_at: new Date().toISOString(),
                class_frequency: `${contractData.classesPerWeek}x`,
                signature_ip: signatureDataObj?.type === 'DIGITAL' ? 'Via Web (Digital)' : `Via Web (${signatureDataObj?.type})`,
                student_signature_url: signatureDataObj?.type === 'UPLOAD_SIG' ? signatureDataObj.url : null,
                signed_document_url: signatureDataObj?.type === 'UPLOAD_DOC' ? signatureDataObj.url : null,
                wise_wolf_signature_token: crypto.randomUUID() // Generate a token for the school's signature
            });

            if (profileError) throw profileError;

            // 2.1 AUTOMATIC SCHEDULING & PROFESSOR ASSIGNMENT
            if (contractData.professorId) {
                console.log("🚀 Associando Professor e Agenda...");

                // A. Link Professor to Student Profile
                const { error: linkError } = await supabase
                    .from('profiles')
                    .update({ professor_id: contractData.professorId })
                    .eq('id', userId);

                if (linkError) console.error("Erro ao vincular professor:", linkError);

                // B. Create Recurring Bookings
                if (contractData.schedule && Array.isArray(contractData.schedule)) {
                    const dayMap: Record<string, string> = {
                        'Monday': 'Segunda',
                        'Tuesday': 'Terça',
                        'Wednesday': 'Quarta',
                        'Thursday': 'Quinta',
                        'Friday': 'Sexta',
                        'Saturday': 'Sábado',
                        'Sunday': 'Domingo'
                    };

                    const bookingsPayload = contractData.schedule.map((slot: any) => ({
                        tenant_id: contractData.unitId,
                        teacher_id: contractData.professorId,
                        student_id: userId,
                        day_of_week: dayMap[slot.day] || slot.day,
                        time_slot: slot.time,
                        start_date: new Date().toISOString().split('T')[0]
                    }));

                    const { error: bookingError } = await supabase
                        .from('bookings')
                        .insert(bookingsPayload);

                    if (bookingError) {
                        console.error("Erro ao criar agenda:", bookingError);
                    } else {
                        console.log("✅ Agenda criada com sucesso:", bookingsPayload.length, "aulas.");
                    }
                }
            }

            // 3. Sync with Asaas
            await asaasService.syncStudent({
                user_id: userId,
                name: name,
                email: email,
                phone: phone,
                cpf: cpf.replace(/\D/g, ''),
                postalCode: postalCode,
                address: address,
                addressNumber: addressNumber
            });

            console.log("🚀 Enviando pagamento para Asaas...");

            // 4. Create Subscription (THE MOMENT OF TRUTH)
            const response = await asaasService.createSubscription({
                user_id: userId,
                value: contractData.value,
                dueDay: contractData.dueDay,
                billingType: billingType,
                planDuration: durationEnum,
                creditCard: creditCardData
            });

            // 3. STRICT ANALYSIS (Safety Lock)
            if (!response || (!response.id && !response.subscription_id) || response.error || response.errors || response.success === false) {
                throw new Error(
                    response?.error ||
                    response?.errors?.[0]?.description ||
                    "Resposta inválida: Sem ID de assinatura."
                );
            }

            // 4. Só passa se sobreviveu à análise acima
            console.log("✅ ID Confirmado:", response.id || response.subscription_id);

            // Save Signature Data for PDF
            setSignatureData({
                acceptedAt: new Date().toISOString(),
                ip: 'Via Web', // Placeholder until Edge Function captures it
                subId: response.id || response.subscription_id
            });

            // --- DISPARO DIRETO DO WHATSAPP (Via Service) ---
            try {
                // Monta a mensagem
                const waMessage = `🐺 *Bem-vindo à Wise Wolf Language!*\n\nOlá ${name}, sua matrícula foi realizada com sucesso! Prepare-se para dominar o inglês.\n\n📄 *Seu Contrato:* ${signatureDataObj?.url || 'https://aluno.wisewolf.com.br'}\n🔐 *Acesso ao Portal:* https://aluno.wisewolf.com.br`;

                console.log("🚀 Enviando WhatsApp (Service)...");

                // Assuming 'wise-wolf' is the correct instance name for notifications
                // Using whatsappService handles number formatting (55 prefix) automatically
                await whatsappService.sendText(contractData.unitId, 'wise-wolf', phone, waMessage);
                console.log("✅ WhatsApp enviado com sucesso!");

            } catch (waError) {
                console.error("❌ Erro ao preparar WhatsApp:", waError);
            }

            // Notifica Diretor (Mantido para controle administrativo)
            supabase.functions.invoke('whatsapp-notificacao-wise', {
                body: {
                    type: 'DIRECTOR_NEW_CONTRACT',
                    data: {
                        student_name: name,
                        class_frequency: `${contractData.classesPerWeek}x`
                    }
                }
            });

            if (signatureDataObj?.url) {
                setSignedPdfUrl(signatureDataObj.url);
            }

            setStep('SUCCESS');

        } catch (err: any) {
            console.error("⛔ ERRO CAPTURADO:", err);

            let errorMessage = err.message || "Ocorreu um erro ao realizar sua matrícula.";

            // 1. Supabase Auth Errors cleaning
            if (errorMessage.includes("User already registered") || errorMessage.includes("already exists")) {
                errorMessage = "Este e-mail já possui cadastro. Acesse sua conta ou recupere a senha.";
            }

            // 2. Asaas Edge Function Errors cleaning
            if (typeof errorMessage === 'string' && errorMessage.includes('asaasErrors')) {
                try {
                    const match = errorMessage.match(/\{.*\}/);
                    if (match) {
                        const parsed = JSON.parse(match[0]);
                        if (parsed.error) errorMessage = parsed.error;
                        else if (parsed.asaasErrors && parsed.asaasErrors.length > 0) {
                            errorMessage = `Erro no Pagamento: ${parsed.asaasErrors[0].description}`;
                        }
                    }
                } catch (e) { }
            }

            // Mostra o erro real
            alert(`⛔ PAGAMENTO RECUSADO:\n\n${errorMessage}`);
            setError(errorMessage);

            // NÃO muda de tela. Fica aqui.
        } finally {
            setLoading(false);
        }
    };

    const handleFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Basic validation is handled by HTML5 'required' attributes
        // We proceed to show the contract for signature
        setStep('CONTRACT');
    };

    if (step === 'SUCCESS') {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={40} className="text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-black text-slate-800 mb-2">Matrícula Confirmada!</h2>
                    <p className="text-slate-600 mb-6">
                        Seu acesso ao portal já foi criado. Verifique seu e-mail para confirmar a conta e acessar suas cobranças.
                    </p>
                    <div className="space-y-3">
                        <a href="/" className="block w-full px-8 py-3 bg-emerald-600 text-white rounded-xl font-bold uppercase tracking-widest hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-600/20">
                            Acessar Portal
                        </a>
                        <button
                            onClick={() => {
                                if (signedPdfUrl) {
                                    window.open(signedPdfUrl, '_blank');
                                } else {
                                    handlePrintContract();
                                }
                            }}
                            className="block w-full px-8 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold uppercase tracking-widest hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                        >
                            <Download size={18} /> Baixar Contrato Assinado
                        </button>
                    </div>

                    {/* Hidden Contract for Printing - Fixed Visibility for ReactToPrint */}
                    <div style={{ position: 'absolute', top: '-10000px', left: 0 }}>
                        <div ref={contractRef}>
                            <ContractDocument
                                studentName={name.toUpperCase()}
                                studentCPF={cpf}
                                studentAddress={`${address}, ${addressNumber} - ${postalCode}`}
                                studentEmail={email}
                                studentPhone={phone}
                                planName={contractData?.planDuration === 12 ? 'Plano Anual' : contractData?.planDuration === 6 ? 'Plano Semestral' : 'Plano Mensal'}
                                planValue={Number(contractData?.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                planDuration={contractData?.planDuration || 12}
                                startDate={new Date().toLocaleDateString('pt-BR')}
                                endDate={new Date(new Date().setMonth(new Date().getMonth() + (contractData?.planDuration || 12))).toLocaleDateString('pt-BR')}
                                dueDay={contractData?.dueDay || 10}
                                classFrequency={contractData?.classesPerWeek || 2}
                                acceptedAt={signatureData?.acceptedAt}
                                userIp={signatureData?.ip}
                                subscriptionId={signatureData?.subId}
                            />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!contractData && !error) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
            <div className="max-w-lg mx-auto bg-white rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                {/* Header */}
                <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                    <div className="relative z-10">
                        <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">Matrícula Online</h1>
                        {contractData && (
                            <div className="flex flex-col gap-2 items-center">
                                <div className="inline-block bg-white/10 backdrop-blur-md border border-white/20 rounded-xl px-4 py-2">
                                    <p className="text-sm font-bold text-blue-100 uppercase tracking-widest">
                                        Plano {contractData.planDuration === 12 ? 'Anual' : contractData.planDuration === 6 ? 'Semestral' : 'Mensal'}
                                    </p>
                                </div>
                                <div className="inline-block bg-white px-4 py-1 rounded-full shadow-lg">
                                    <p className="text-sm font-black text-blue-900">
                                        {contractData.classesPerWeek}x na semana • R$ {Number(contractData.value).toFixed(2)}/mês
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                    {/* Decorative Circles */}
                    <div className="absolute top-0 left-0 w-32 h-32 bg-blue-500/20 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2"></div>
                    <div className="absolute bottom-0 right-0 w-40 h-40 bg-purple-500/20 rounded-full blur-3xl translate-x-1/2 translate-y-1/2"></div>
                </div>

                <div className="p-8">
                    {error && (
                        <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3">
                            <AlertCircle className="text-red-500 shrink-0" size={20} />
                            <p className="text-sm text-red-600 font-bold">{error}</p>
                        </div>
                    )}

                    <form onSubmit={handleFormSubmit} className="space-y-6">
                        {/* 1. Payment Method Selection */}
                        <div className="space-y-3">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                <CreditCard size={14} /> Forma de Pagamento
                            </h3>
                            <div className="grid grid-cols-3 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setBillingType('PIX')}
                                    className={`flex flex-col items-center justify-center p-4 rounded-2xl border-2 transition-all gap-2 ${billingType === 'PIX' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}
                                >
                                    <QrCode size={24} />
                                    <span className="text-[10px] font-black uppercase tracking-widest">Pix</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBillingType('BOLETO')}
                                    className={`flex flex-col items-center justify-center p-4 rounded-2xl border-2 transition-all gap-2 ${billingType === 'BOLETO' ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}
                                >
                                    <Barcode size={24} />
                                    <span className="text-[10px] font-black uppercase tracking-widest">Boleto</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBillingType('CREDIT_CARD')}
                                    className={`flex flex-col items-center justify-center p-4 rounded-2xl border-2 transition-all gap-2 ${billingType === 'CREDIT_CARD' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}
                                >
                                    <CreditCard size={24} />
                                    <span className="text-[10px] font-black uppercase tracking-widest">Cartão</span>
                                </button>
                            </div>

                            {billingType === 'CREDIT_CARD' && (
                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-4 animate-in fade-in duration-300">
                                    <div className="flex items-center justify-center gap-2 text-emerald-600 mb-2">
                                        <Lock size={12} />
                                        <span className="text-[10px] uppercase font-black tracking-widest">Ambiente Seguro (SSL)</span>
                                    </div>

                                    <div className="space-y-4">
                                        <input
                                            required
                                            type="tel"
                                            inputMode="numeric"
                                            autoComplete="cc-number"
                                            placeholder="Número do Cartão"
                                            value={ccNumber}
                                            onChange={e => setCcNumber(e.target.value)}
                                            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-slate-400"
                                        />
                                        <input
                                            required
                                            type="text"
                                            autoComplete="cc-name"
                                            placeholder="Nome Impresso no Cartão"
                                            value={ccName}
                                            onChange={e => setCcName(e.target.value)}
                                            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-slate-400"
                                        />
                                        <div className="grid grid-cols-2 gap-4">
                                            <input
                                                required
                                                type="text"
                                                autoComplete="cc-exp"
                                                placeholder="Validade (MM/AAAA)"
                                                maxLength={7}
                                                value={ccExpiry}
                                                onChange={(e) => {
                                                    let v = e.target.value.replace(/\D/g, '');
                                                    if (v.length >= 2) {
                                                        v = v.substring(0, 2) + '/' + v.substring(2, 6);
                                                    }
                                                    setCcExpiry(v);
                                                }}
                                                className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-slate-400"
                                            />
                                            <input
                                                required
                                                type="tel"
                                                inputMode="numeric"
                                                autoComplete="cc-csc"
                                                placeholder="CVV"
                                                value={ccCcv}
                                                onChange={e => setCcCcv(e.target.value)}
                                                maxLength={4}
                                                className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-slate-400"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-center gap-2 pt-2 text-[#a3a3a3]">
                                        <ShieldCheck size={14} />
                                        <p className="text-[10px] font-medium">Pagamento processado via Asaas</p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* 2. Personal Data */}
                        <div className="space-y-4">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                <User size={14} /> Dados Pessoais
                            </h3>

                            <input
                                required
                                placeholder="Nome Completo"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                            />

                            <div className="grid grid-cols-2 gap-4">
                                <input
                                    required
                                    placeholder="CPF"
                                    value={cpf}
                                    onChange={e => setCpf(e.target.value)}
                                    className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                                />
                                <input
                                    required
                                    placeholder="WhatsApp"
                                    value={phone}
                                    onChange={e => setPhone(e.target.value)}
                                    className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                                />
                            </div>
                        </div>

                        {/* 3. Address */}
                        <div className="space-y-4 pt-2">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                <MapPin size={14} /> Endereço
                            </h3>
                            <div className="grid grid-cols-3 gap-4">
                                <input
                                    required
                                    placeholder="CEP"
                                    value={postalCode}
                                    onChange={e => setPostalCode(e.target.value)}
                                    className="col-span-1 w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                                />
                                <input
                                    required
                                    placeholder="Número"
                                    value={addressNumber}
                                    onChange={e => setAddressNumber(e.target.value)}
                                    className="col-span-2 w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                                />
                            </div>
                            <input
                                required
                                placeholder="Endereço Completo (Rua, Bairro...)"
                                value={address}
                                onChange={e => setAddress(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                            />
                        </div>

                        {/* 4. Credentials */}
                        <div className="space-y-4 pt-2">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                <Lock size={14} /> Acesso ao Portal
                            </h3>
                            <input
                                type="email"
                                required
                                placeholder="Seu melhor e-mail"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                            />
                            <input
                                type="password"
                                required
                                placeholder="Crie uma senha"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-800 focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-slate-400"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-5 bg-[#002366] hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2 mt-6 disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                            {loading ? <Loader2 className="animate-spin" /> : <>Confirmar Matrícula <ArrowRight size={18} /></>}
                        </button>

                        <p className="text-center text-[10px] text-slate-400 font-medium">
                            Ao clicar em Confirmar, você aceita os termos de serviço e a política de privacidade da escola.
                        </p>
                    </form>
                </div>
            </div>

            {/* Signature Modal */}
            {contractData && (
                <ContractModal
                    isOpen={step === 'CONTRACT'}
                    onClose={() => setStep('FORM')}
                    onConfirm={handleRegister}
                    loading={loading}
                    studentName={name.toUpperCase()}
                    studentCPF={cpf}
                    studentAddress={`${address}, ${addressNumber} - ${postalCode}`}
                    studentEmail={email}
                    studentPhone={phone}
                    planName={contractData.planDuration === 12 ? 'Plano Anual' : contractData.planDuration === 6 ? 'Plano Semestral' : 'Plano Mensal'}
                    planValue={Number(contractData.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    planDuration={contractData.planDuration || 12}
                    startDate={new Date().toLocaleDateString('pt-BR')}
                    endDate={new Date(new Date().setMonth(new Date().getMonth() + (contractData.planDuration || 12))).toLocaleDateString('pt-BR')}
                    dueDay={contractData.dueDay || 10}
                    classFrequency={contractData.classesPerWeek || 2}
                />
            )}
        </div>
    );
};

export default PublicRegistration;
