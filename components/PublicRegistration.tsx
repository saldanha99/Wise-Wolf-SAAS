import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { whatsappService } from '../services/whatsappService';
import { ContractDocument } from './ContractDocument';
import ContractModal from './ContractModal';
import { useReactToPrint } from 'react-to-print';
import { User, Mail, Lock, Phone, MapPin, CheckCircle, AlertCircle, ArrowRight, Loader2, QrCode, Barcode, CreditCard, ShieldCheck, Download, FileText, ArrowLeft } from 'lucide-react';

const PublicRegistration: React.FC = () => {
    const [loading, setLoading] = useState(false);
    // Steps: PAYMENT_SELECTION -> FORM -> ENROLLMENT -> ENROLLMENT_PAYMENT -> CONTRACT -> SUCCESS
    const [step, setStep] = useState<'PAYMENT_SELECTION' | 'FORM' | 'ENROLLMENT' | 'ENROLLMENT_PAYMENT' | 'CONTRACT' | 'SUCCESS'>('PAYMENT_SELECTION');
    const [enrollmentPix, setEnrollmentPix] = useState<{ code: string; qrCode: string; paymentId: string } | null>(null);
    const [checkingPayment, setCheckingPayment] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [contractData, setContractData] = useState<any>(null);
    // Signature Data for PDF
    const [signatureData, setSignatureData] = useState<{ acceptedAt: string; ip: string; subId: string } | null>(null);
    const [signedPdfUrl, setSignedPdfUrl] = useState<string>('');

    // Affiliate Ref
    const [referrerTeacherId, setReferrerTeacherId] = useState<string | null>(null);
    const [referrerStudentId, setReferrerStudentId] = useState<string | null>(null);

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState(''); // WhatsApp
    const [cpf, setCpf] = useState('');
    const [postalCode, setPostalCode] = useState('');
    const [address, setAddress] = useState('');
    const [addressNumber, setAddressNumber] = useState('');

    // Enrollment (Ficha de Matrícula) Fields

    // Payment Logic
    const [billingType, setBillingType] = useState<'PIX' | 'BOLETO' | 'CREDIT_CARD'>('PIX');

    // Credit Card Fields
    const [ccName, setCcName] = useState('');
    const [ccNumber, setCcNumber] = useState('');
    const [ccExpiry, setCcExpiry] = useState(''); // MM/YYYY
    const [ccCcv, setCcCcv] = useState('');

    // Contract Printing Logic
    const contractRef = useRef<HTMLDivElement>(null);
    const handlePrintContract = useReactToPrint({
        contentRef: contractRef,
        documentTitle: `Contrato_WiseWolf_${name ? name.replace(/\s+/g, '_') : 'Aluno'}`,
    });

    // Calculate dynamic dates based on Due Day and optional Start Date
    const getContractDates = () => {
        const dueDay = contractData?.dueDay || 10;
        const duration = contractData?.planDuration || 12;

        let start: Date;
        
        if (contractData?.startDate) {
            // Use the specific start date provided in the link
            start = new Date(contractData.startDate + 'T12:00:00'); // Midday to avoid TZ issues
        } else {
            start = new Date();
            // If due day has passed or is today, start next month
            if (start.getDate() >= dueDay) {
                start.setMonth(start.getMonth() + 1);
            }
            // Handle edge cases like Feb 30th -> Mar 2nd automatically by JS
            start.setDate(dueDay); // Bind to due day of current month/year
        }

        const end = new Date(start);
        end.setMonth(start.getMonth() + (duration || 1));

        return {
            startDate: start.toLocaleDateString('pt-BR'),
            endDate: end.toLocaleDateString('pt-BR')
        };
    };

    useEffect(() => {
        // Decode Query Params — supports JWT token (new) and Base64 data (legacy)
        const params = new URLSearchParams(window.location.search);
        const jwtToken = params.get('token');
        const encodedData = params.get('data');
        const ref = params.get('ref');
        const refStudent = params.get('ref_student');
        if (ref) setReferrerTeacherId(ref);
        if (refStudent) setReferrerStudentId(refStudent);

        const loadOffer = async () => {
            try {
                // Dynamic import to avoid circular deps at module level
                const { resolveOffer } = await import('../services/offerService');

                const result = await resolveOffer({
                    token: jwtToken,
                    legacyData: encodedData,
                    route: '/matricula',
                });

                if (result.success && result.payload) {
                    const data = result.payload;
                    setContractData({
                        ...data,
                        classSchedule: data.classSchedule || data.schedule || [],
                        requiresEnrollment: data.requiresEnrollment !== false,
                        _offerId: result.offerId, // Track for consumption later
                        _source: result.source,
                    });
                    // Pre-fill from experimental trial data if available
                    if (data.studentName && !name) setName(data.studentName);
                    if (data.studentPhone && !phone) setPhone(data.studentPhone);
                } else {
                    setError(result.message || "Link de matrícula inválido ou expirado.");
                }
            } catch (e) {
                // Last resort: try local decode
                if (encodedData) {
                    try {
                        const jsonStr = decodeURIComponent(escape(atob(encodedData)));
                        const data = JSON.parse(jsonStr);
                        setContractData({
                            ...data,
                            classSchedule: data.classSchedule || data.schedule || [],
                            requiresEnrollment: data.requiresEnrollment !== false
                        });
                        if (data.studentName && !name) setName(data.studentName);
                        if (data.studentPhone && !phone) setPhone(data.studentPhone);
                    } catch {
                        setError("Link de matrícula inválido ou expirado.");
                    }
                } else {
                    setError("Link de matrícula inválido. Solicite um novo link à escola.");
                }
            }
        };

        if (jwtToken || encodedData) {
            loadOffer();
        } else {
            setError("Link de matrícula inválido. Solicite um novo link à escola.");
        }
    }, []);

    const handleRegister = async (signatureDataObj?: { type: 'DIGITAL' | 'UPLOAD_SIG' | 'UPLOAD_DOC', url?: string }) => {
        if (!contractData) return;
        setLoading(true);
        setError(null);

        try {
            // BLOQUEANTE: consome a oferta ANTES de criar qualquer estado persistente.
            // Se o link ja foi usado/expirou, abortamos antes de criar conta/cobrança.
            if (contractData._offerId) {
                const { error: consumeErr } = await supabase.rpc('consume_offer', { p_offer_id: contractData._offerId });
                if (consumeErr) {
                    console.error('❌ consume_offer failed:', consumeErr);
                    throw new Error('Este link de matrícula já foi utilizado ou expirou. Solicite um novo link à escola.');
                }
                console.log('✅ Offer consumed:', contractData._offerId);
            }

            // Map numeric duration to Enum
            const durationEnum = contractData.planDuration === 12 ? 'ANNUAL' : contractData.planDuration === 6 ? 'SEMESTER' : 'RECURRENT';

            // Validate Credit Card if selected
            let creditCardData = null;
            if (billingType === 'CREDIT_CARD') {
                if (!ccName || !ccNumber || !ccExpiry || !ccCcv) {
                    throw new Error("Preencha todos os dados do cartão de crédito.");
                }
                const [expMonth, expYear] = ccExpiry.split('/');
                if (!expMonth || !expYear || expMonth.length !== 2 || (expYear.length !== 2 && expYear.length !== 4)) {
                    throw new Error("Data de validade inválida. Use o formato MM/AA ou MM/AAAA (ex: 12/30 ou 12/2030).");
                }

                // Normaliza o ano para 4 dígitos se vier 2 (ex: "30" -> "2030")
                const normalizedYear = expYear.length === 2 ? `20${expYear}` : expYear;

                creditCardData = {
                    holderName: ccName,
                    number: ccNumber.replace(/\D/g, ''),
                    expiryMonth: expMonth,
                    expiryYear: normalizedYear,
                    ccv: ccCcv
                };
            }

            console.log("🚀 Iniciando processo de matrícula...");

            // 1. Create Auth User OR Sign In if exists
            let userId = null;

            const { data: authData, error: authError } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: { full_name: name, role: 'STUDENT', tenant_id: contractData.unitId }
                }
            });

            if (authError) {
                // Recover from "User already registered" by signing in
                if (authError.message.includes("already registered") || authError.message.includes("already exists")) {
                    console.warn("Usuário já existe. Tentando login para continuar cadastro...");
                    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                        email,
                        password
                    });

                    if (signInError) throw new Error("Este e-mail já está cadastrado. tentei fazer login mas a senha não confere.");
                    if (!signInData.user) throw new Error("Falha ao recuperar usuário existente.");

                    userId = signInData.user.id;
                } else {
                    throw authError; // Real error
                }
            } else {
                if (!authData.user) throw new Error("Erro ao criar usuário.");
                userId = authData.user.id;
            }

            // 2. Create Profile (with contract_accepted = true)
            const profileData: any = {
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
                module: 'General',
                contract_accepted: true,
                documentation_status: 'APPROVED',
                accepted_at: new Date().toISOString(),
                class_frequency: `${contractData.classesPerWeek}x`,
                signature_ip: signatureDataObj?.type === 'DIGITAL' ? 'Via Web (Digital)' : `Via Web (${signatureDataObj?.type})`,
                student_signature_url: signatureDataObj?.type === 'UPLOAD_SIG' ? signatureDataObj.url : null,
                signed_document_url: signatureDataObj?.type === 'UPLOAD_DOC' ? signatureDataObj.url : null,
                wise_wolf_signature_token: crypto.randomUUID(),
                enrollment_fee: contractData.enrollmentFee || 0,
                enrollment_fee_paid: (contractData.enrollmentFee || 0) > 0 ? false : true,
                enrollment_payment_id: enrollmentPix?.paymentId || null,
                professor_id2: contractData.professorId2 || null,
                start_date: contractData.startDate || null,
            };

            // Affiliate tracking — teacher referral
            if (referrerTeacherId) {
                profileData.referrer_teacher_id = referrerTeacherId;
            }
            // Affiliate tracking — student referral
            if (referrerStudentId) {
                profileData.referrer_student_id = referrerStudentId;
            }

            const { error: profileError } = await supabase.from('profiles').upsert(profileData);

            if (profileError) throw profileError;

            // 2.1 AUTOMATIC SCHEDULING & PROFESSOR ASSIGNMENT
            if (contractData.professorId) {
                console.log("🚀 Professor associado:", contractData.professorId);
                // B. Bookings and professor profile linking are now handled server-side by the sync-student-asaas edge function to bypass RLS
            }
            if (contractData.professorId2) {
                console.log("🚀 Segundo Professor associado:", contractData.professorId2);
            }

            // 3. Sync with Asaas (+ full profile data via service role)
            const syncResponse = await asaasService.syncStudent({
                user_id: userId,
                name: name,
                email: email,
                phone: phone,
                cpf: cpf.replace(/\D/g, ''),
                postalCode: postalCode,
                address: address,
                addressNumber: addressNumber,
                // Extended profile fields (saved server-side with service role, bypasses RLS)
                tenant_id: contractData.unitId,
                monthly_fee: contractData.value,
                due_day: contractData.dueDay,
                class_frequency: `${contractData.classesPerWeek}x`,
                professor_id: contractData.professorId || null,
                professor_id_2: contractData.professorId2 || null,
                classSchedule: contractData.classSchedule || [],
                contract_accepted: true,
                documentation_status: 'APPROVED',
                signature_ip: signatureDataObj?.type === 'DIGITAL' ? 'Via Web (Digital)' : `Via Web (${signatureDataObj?.type})`,
                student_signature_url: signatureDataObj?.type === 'UPLOAD_SIG' ? signatureDataObj.url : null,
                signed_document_url: signatureDataObj?.type === 'UPLOAD_DOC' ? signatureDataObj.url : null,
                startDate: contractData.startDate || null,
            });

            console.log("🚀 Enviando pagamento para Asaas...");

            // 4. Create Subscription (THE MOMENT OF TRUTH)
            const response = await asaasService.createSubscription({
                user_id: userId,
                customer: syncResponse?.asaas_customer_id,
                value: contractData.value,
                dueDay: contractData.dueDay,
                billingType: billingType,
                planDuration: durationEnum,
                creditCard: creditCardData,
                creditCardHolderInfo: billingType === 'CREDIT_CARD' ? {
                    name,
                    email,
                    cpfCnpj: cpf.replace(/\D/g, ''),
                    postalCode,
                    addressNumber,
                    phone: phone.replace(/\D/g, '') // Asaas prefers numbers only
                } : undefined
            });

            // 3. STRICT ANALYSIS (Safety Lock)
            if (!response || (!response.id && !response.subscription_id) || response.error || response.errors || response.success === false) {
                throw new Error(
                    response?.error ||
                    response?.errors?.[0]?.description ||
                    "Resposta inválida: Sem ID de assinatura."
                );
            }

            const confirmedSubId = response.id || response.subscription_id;
            console.log("✅ ID Confirmado:", confirmedSubId);

            // 4. Safety-net: Update profile with subscription data (edge function should have done this, but ensure it)
            try {
                await supabase.from('profiles').update({
                    subscription_id: confirmedSubId,
                    monthly_fee: contractData.value,
                    due_day: contractData.dueDay,
                    status_financial: 'ACTIVE',
                }).eq('id', userId);
                console.log("✅ Perfil atualizado com subscription_id:", confirmedSubId);
            } catch (profileErr) {
                console.error("⚠️ Erro ao atualizar perfil (não-bloqueante):", profileErr);
            }

            // Save Signature Data for PDF
            setSignatureData({
                acceptedAt: new Date().toISOString(),
                ip: 'Via Web',
                subId: confirmedSubId
            });

            try {
                console.log("🚀 Invocando Edge Function de Boas-vindas (Via Invoke)...");
                const { data: waData, error: waInvokeError } = await supabase.functions.invoke('whatsapp-notificacao-matricula', {
                    body: {
                        phone: `55${phone.replace(/\D/g, '')}`,
                        full_name: name,
                        email: email,
                        password: password,
                        tenant_id: contractData.unitId,
                        link_portal: 'https://system.wisewolflanguage.com.br'
                    }
                });

                if (waInvokeError) throw waInvokeError;
                console.log("✅ WhatsApp de Boas-vindas disparado com sucesso!", waData);

            } catch (waError) {
                console.error("❌ Erro ao enviar WhatsApp de Boas-vindas:", waError);
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
            }).catch(e => console.warn("Supressed Director Notification Error:", e));

            if (signatureDataObj?.url) {
                setSignedPdfUrl(signatureDataObj.url);
            }

            // ===== VENDOR COMMISSION TRACKING =====
            if (contractData.vendorId && userId) {
                try {
                    const { data: vendorProfile } = await supabase
                        .from('profiles')
                        .select('commission_rate')
                        .eq('id', contractData.vendorId)
                        .single();

                    const commissionAmount = vendorProfile?.commission_rate ?? 3000;

                    await supabase.from('vendor_commissions').insert({
                        vendor_id: contractData.vendorId,
                        student_id: userId,
                        amount_brl: commissionAmount,
                        status: 'PENDING',
                        tenant_id: contractData.unitId,
                    });
                } catch (commErr) {
                    console.error('⚠️ Erro ao registrar comissão (não-bloqueante):', commErr);
                }
            }

            // ===== OPPORTUNITY CONVERSION TRACKING (ATOMIC) =====
            // If this link came from an experimental trial, mark the opportunity as WON
            if (contractData.opportunityId && userId) {
                try {
                    console.log('📊 Atualizando funil: opportunity', contractData.opportunityId, '→ WON');

                    // Use atomic RPC instead of direct update
                    const { data: wonResult, error: wonError } = await supabase.rpc('mark_opportunity_won', {
                        p_opportunity_id: contractData.opportunityId,
                        p_student_id: userId,
                        p_actor_id: userId,
                    });

                    if (wonError) console.warn('mark_opportunity_won RPC error:', wonError);

                    // Mark enrollment link as USED
                    await supabase
                        .from('enrollment_links')
                        .update({
                            status: 'USED',
                            used_at: new Date().toISOString(),
                        })
                        .eq('opportunity_id', contractData.opportunityId)
                        .eq('status', 'PENDING');

                    // Mark enrollment_intents as USED (new table)
                    await supabase
                        .from('enrollment_intents')
                        .update({
                            status: 'USED',
                            used_at: new Date().toISOString(),
                        })
                        .eq('opportunity_id', contractData.opportunityId)
                        .eq('status', 'PENDING')
                        .then(() => {}).catch(() => {}); // Non-blocking

                    console.log('✅ Funil atualizado com sucesso!');
                } catch (funnelErr) {
                    // Non-blocking — don't fail registration because of funnel tracking
                    console.error('⚠️ Erro ao atualizar funil (não-bloqueante):', funnelErr);
                }
            }

            if (contractData.requiresEnrollment !== false && contractData.enrollmentFee > 0) {
                try {
                    console.log("🚀 Gerando Pix de Matrícula Pós-Contrato...");
                    const res = await asaasService.createEnrollmentPix(contractData.enrollmentFee, {
                        name,
                        email,
                        cpfCnpj: cpf,
                        phone
                    });
                    setEnrollmentPix({
                        code: res.pixCode,
                        qrCode: res.qrCode,
                        paymentId: res.paymentId
                    });
                    setStep('ENROLLMENT_PAYMENT');
                } catch (pixErr) {
                    console.error("⚠️ Erro ao gerar Pix (não-bloqueante p/ contrato):", pixErr);
                    setStep('SUCCESS'); // Goes to success even if Pix fails to avoid blocking the contract
                }
            } else {
                setStep('SUCCESS');
            }

        } catch (err: any) {
            console.error("⛔ ERRO CAPTURADO:", err);

            let errorMessage = "Ocorreu um erro ao realizar sua matrícula.";

            // Extração de Erro Robusta
            if (err instanceof Error) {
                errorMessage = err.message;
            } else if (typeof err === 'string') {
                errorMessage = err;
            } else if (typeof err === 'object' && err !== null) {
                // Caso a Edge Function retorne um objeto JSON (ex: {error: "CPF inválido"})
                if (err.error && typeof err.error === 'string') {
                    errorMessage = err.error;
                } else if (err.message && typeof err.message === 'string') {
                    errorMessage = err.message;
                }
            }

            // 1. Limpeza de erros do Supabase Auth
            if (errorMessage.includes("User already registered") || errorMessage.includes("already exists")) {
                errorMessage = "Este e-mail já possui cadastro. Acesse sua conta ou recupere a senha.";
            }

            // 2. Extração de erros aninhados do Asaas (JSON dentro de string)
            if (typeof errorMessage === 'string' && (errorMessage.includes('asaasErrors') || errorMessage.includes('{"error"'))) {
                try {
                    const match = errorMessage.match(/\{.*\}/);
                    if (match) {
                        const parsed = JSON.parse(match[0]);
                        if (parsed.error && typeof parsed.error === 'string') {
                            errorMessage = parsed.error;
                        } else if (parsed.asaasErrors && parsed.asaasErrors.length > 0) {
                            errorMessage = parsed.asaasErrors[0].description || "Erro no pagamento Asaas.";
                        }
                    }
                } catch (e) {
                    console.error("Falha ao fazer parse do erro interno:", e);
                }
            }

            // Mostra o erro real
            alert(`⛔ MENSAGEM DO SISTEMA:\n\n${errorMessage}`);
            setError(errorMessage);

            // NÃO muda de tela. Fica aqui para permitr correção dos dados.
        } finally {
            setLoading(false);
        }
    };

    const handleFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // If requires enrollment (non-avulso), show enrollment form first
        if (contractData?.requiresEnrollment) {
            setStep('ENROLLMENT');
        } else {
            setStep('CONTRACT');
        }
    };

    const handleEnrollmentSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setStep('CONTRACT');
    };

    const handleCheckEnrollmentPayment = async () => {
        if (!enrollmentPix) return;
        setCheckingPayment(true);
        try {
            // In a real scenario, we'd poll or wait for webhook. 
            // For now, let's allow manual check or just simulate success if sandbox
            const res = await asaasService.checkPaymentStatus(enrollmentPix.paymentId);
            if (res.status === 'RECEIVED' || res.status === 'CONFIRMED') {
                
                // Update profile to mark fee as paid
                if (contractData?.enrollmentFee > 0 && res.paymentId) {
                    await supabase.from('profiles').update({
                        enrollment_fee_paid: true,
                        enrollment_payment_id: res.paymentId
                    }).eq('id', (await supabase.auth.getUser()).data.user?.id);
                }

                setStep('SUCCESS');
            } else {
                alert("Pagamento ainda não identificado. Se você já pagou, aguarde alguns instantes.");
            }
        } catch (e) {
            // Fallback: if check fails, just try again
            console.error(e);
        } finally {
            setCheckingPayment(false);
        }
    };

    // ========== PAYMENT SELECTION STEP ==========
    if (step === 'PAYMENT_SELECTION') {
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

                        <div className="text-center mb-8">
                            <h2 className="text-xl font-black text-slate-800 mb-2">Como você prefere pagar?</h2>
                            <p className="text-slate-500 text-sm">Selecione sua forma de pagamento para prosseguir com a matrícula.</p>
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('PIX');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-slate-100 bg-white hover:border-emerald-500 hover:bg-emerald-50 hover:shadow-lg hover:shadow-emerald-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <QrCode size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-slate-800 group-hover:text-emerald-700">Pix</h3>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('CREDIT_CARD');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-slate-100 bg-white hover:border-blue-500 hover:bg-blue-50 hover:shadow-lg hover:shadow-blue-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <CreditCard size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-slate-800 group-hover:text-blue-700">Cartão</h3>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('BOLETO');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-slate-100 bg-white hover:border-amber-500 hover:bg-amber-50 hover:shadow-lg hover:shadow-amber-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <Barcode size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-slate-800 group-hover:text-amber-700">Boleto</h3>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ========== ENROLLMENT STEP (Ficha de Matrícula) ==========
    // ========== ENROLLMENT PAYMENT STEP (PIX QR CODE) ==========
    if (step === 'ENROLLMENT_PAYMENT') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
                <div className="max-w-lg mx-auto bg-white rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                    <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                        <div className="relative z-10 text-white">
                            <QrCode className="mx-auto mb-4" size={48} />
                            <h1 className="text-2xl font-black uppercase tracking-tight">Taxa de Matrícula</h1>
                            <p className="text-blue-100/80 text-sm">Contrato Assinado com Sucesso! 📜</p>
                            <p className="text-blue-100/60 text-[10px] mt-1 uppercase font-bold tracking-widest">Agora, pague a matrícula para garantir sua vaga</p>
                        </div>
                    </div>

                    <div className="p-8 text-center space-y-6">
                        <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-2xl inline-block">
                            <p className="text-xs font-bold text-emerald-600 uppercase tracking-widest mb-1">Valor a Pagar</p>
                            <p className="text-3xl font-black text-emerald-700">R$ {contractData?.enrollmentFee?.toFixed(2)}</p>
                        </div>

                        {enrollmentPix?.qrCode ? (
                            <div className="bg-white p-4 rounded-3xl border-4 border-slate-50 inline-block shadow-inner">
                                <img 
                                    src={`data:image/png;base64,${enrollmentPix.qrCode}`} 
                                    alt="Asaas Pix QR Code" 
                                    className="w-64 h-64 mx-auto"
                                />
                            </div>
                        ) : (
                            <div className="h-64 flex items-center justify-center">
                                <Loader2 className="animate-spin text-slate-300" size={48} />
                            </div>
                        )}

                        <div className="space-y-3">
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Código Pix (Copia e Cola)</p>
                            <div className="flex gap-2">
                                <input 
                                    readOnly
                                    value={enrollmentPix?.code || ''}
                                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-mono text-slate-500 overflow-hidden text-ellipsis"
                                />
                                <button 
                                    onClick={() => {
                                        if (enrollmentPix?.code) {
                                            navigator.clipboard.writeText(enrollmentPix.code);
                                            alert("Código copiado!");
                                        }
                                    }}
                                    className="bg-blue-600 text-white p-3 rounded-xl hover:bg-blue-700 transition-colors"
                                >
                                    <FileText size={20} />
                                </button>
                            </div>
                        </div>

                        <div className="pt-6 border-t border-slate-100 flex flex-col gap-3">
                            <button
                                onClick={handleCheckEnrollmentPayment}
                                disabled={checkingPayment}
                                className="w-full py-4 bg-[#002366] hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2"
                            >
                                {checkingPayment ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle size={18} />}
                                Já realizei o pagamento
                            </button>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">
                                A confirmação pode levar até 30 segundos após o pagamento.
                            </p>
                            <button 
                                onClick={() => setStep('ENROLLMENT')}
                                className="text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors uppercase"
                            >
                                Corrigir dados da matrícula
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (step === 'ENROLLMENT') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
                <div className="max-w-lg mx-auto bg-white rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                    {/* Header */}
                    <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                        <div className="relative z-10">
                            <div className="flex items-center justify-center gap-2 mb-2">
                                <FileText className="text-blue-300" size={24} />
                                <h1 className="text-2xl font-black text-white uppercase tracking-tight">Ficha de Matrícula</h1>
                            </div>
                            <p className="text-blue-100/80 text-sm">Preencha os dados para oficializar sua matrícula</p>
                        </div>
                        <div className="absolute top-0 left-0 w-32 h-32 bg-blue-500/20 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2"></div>
                        <div className="absolute bottom-0 right-0 w-40 h-40 bg-red-500/20 rounded-full blur-3xl translate-x-1/2 translate-y-1/2"></div>
                    </div>

                    <form onSubmit={handleEnrollmentSubmit} className="p-8 space-y-6">
                        {/* Dados do Aluno (já preenchido) */}
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <User size={14} /> Dados do Aluno
                            </h3>
                            <div className="space-y-2 text-sm text-slate-600">
                                <p><strong>Nome:</strong> {name}</p>
                                <p><strong>CPF:</strong> {cpf}</p>
                                <p><strong>Email:</strong> {email}</p>
                                <p><strong>Telefone:</strong> {phone}</p>
                                <p><strong>Endereço:</strong> {address}, {addressNumber} - CEP: {postalCode}</p>
                            </div>
                        </div>

                        {/* Navigation Buttons */}
                        <div className="flex gap-3 pt-4">
                            <button
                                type="button"
                                onClick={() => setStep('FORM')}
                                className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
                            >
                                <ArrowLeft size={16} /> Voltar
                            </button>
                            <button
                                type="submit"
                                className="flex-[2] py-4 bg-[#002366] hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2"
                            >
                                Continuar para Contrato <ArrowRight size={16} />
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    }

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
                        {/* 
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
                        */}
                    </div>

                    {/* Hidden Contract Form for PDF Printing */}
                    <div className="hidden">
                        <div ref={contractRef}>
                            <ContractDocument
                                studentName={name}
                                studentCPF={cpf.replace(/\D/g, '')}
                                studentAddress={`${address}, ${addressNumber} - CEP: ${postalCode}`}
                                studentEmail={email}
                                studentPhone={phone}
                                planName={`Plano ${contractData.planDuration === 12 ? 'Anual' : contractData.planDuration === 6 ? 'Semestral' : 'Mensal'}`}
                                planValue={Number(contractData.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                totalValue={(Number(contractData.value) * (contractData.planDuration || 1)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                planDuration={contractData.planDuration || 1}
                                startDate={getContractDates().startDate}
                                endDate={getContractDates().endDate}
                                dueDay={contractData.dueDay || 10}
                                classFrequency={contractData.classesPerWeek || 2}
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
                        {/* 1. Payment Method Overview */}
                        <div className="space-y-3 relative">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                    <CreditCard size={14} /> Forma de Pagamento
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => setStep('PAYMENT_SELECTION')}
                                    className="text-[10px] font-bold text-blue-600 uppercase tracking-widest hover:underline"
                                >
                                    Alterar
                                </button>
                            </div>
                            
                            {billingType === 'PIX' && (
                                <div className="flex items-center p-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800">
                                    <QrCode size={24} className="text-emerald-600 mr-3 shrink-0" />
                                    <div>
                                        <h4 className="font-bold text-sm">Pagamento via Pix</h4>
                                        <p className="text-xs text-emerald-600/80">O QR Code será gerado após concluir o cadastro.</p>
                                    </div>
                                </div>
                            )}

                            {billingType === 'BOLETO' && (
                                <div className="flex items-center p-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-800">
                                    <Barcode size={24} className="text-amber-600 mr-3 shrink-0" />
                                    <div>
                                        <h4 className="font-bold text-sm">Pagamento via Boleto</h4>
                                        <p className="text-xs text-amber-600/80">O boleto será gerado após concluir o cadastro.</p>
                                    </div>
                                </div>
                            )}

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
                                    placeholder="WhatsApp (com DDD)"
                                    value={phone}
                                    onChange={e => {
                                        let v = e.target.value.replace(/\D/g, '');
                                        // Mask: (XX) XXXXX-XXXX
                                        if (v.length > 11) v = v.substring(0, 11);
                                        if (v.length > 2) v = `(${v.substring(0, 2)}) ${v.substring(2)}`;
                                        if (v.length > 10) v = `${v.substring(0, 10)}-${v.substring(10)}`;
                                        setPhone(v);
                                    }}
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
                    totalValue={(Number(contractData.value || 0) * (contractData.planDuration || 1)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    planDuration={contractData.planDuration || 12}
                    startDate={getContractDates().startDate}
                    endDate={getContractDates().endDate}
                    dueDay={contractData.dueDay || 10}
                    classFrequency={contractData.classesPerWeek || 2}
                />
            )}

            {/* Hidden Contract for Printing - Moved outside conditional render */}
            <div style={{ position: 'absolute', top: '-9999px', left: '-9999px' }}>
                <div ref={contractRef}>
                    <ContractDocument
                        studentName={name.toUpperCase()}
                        studentCPF={cpf}
                        studentAddress={`${address}, ${addressNumber} - ${postalCode}`}
                        studentEmail={email}
                        studentPhone={phone}
                        planName={contractData?.planDuration === 12 ? 'Plano Anual' : contractData?.planDuration === 6 ? 'Plano Semestral' : 'Plano Mensal'}
                        planValue={Number(contractData?.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        totalValue={(Number(contractData?.value || 0) * (contractData?.planDuration || 12)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        planDuration={contractData?.planDuration || 12}
                        startDate={getContractDates().startDate}
                        endDate={getContractDates().endDate}
                        dueDay={contractData?.dueDay || 10}
                        classFrequency={contractData?.classesPerWeek || 2}
                        acceptedAt={signatureData?.acceptedAt}
                        userIp={signatureData?.ip}
                        subscriptionId={signatureData?.subId}
                    />
                </div>
            </div>
        </div>
    );
};

export default PublicRegistration;
