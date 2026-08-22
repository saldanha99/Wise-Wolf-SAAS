import React, { useState, useEffect, useRef } from 'react';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { ContractDocument, type SchoolInfo } from './ContractDocument';
import { getSchoolInfo } from '../lib/schoolInfo';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';
import ContractModal from './ContractModal';
import { useReactToPrint } from 'react-to-print';
import { User, Mail, Lock, Phone, MapPin, CheckCircle, AlertCircle, ArrowRight, Loader2, QrCode, Barcode, CreditCard, ShieldCheck, Download, FileText, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import {
    calculateEnrollmentQuote,
    digitsOnly,
    formatBrl,
    formatCpf,
    formatDateBr,
    isValidBrazilianMobile,
    isValidCardExpiry,
    isValidCpf,
    isValidCreditCardNumber,
    isValidEmail,
    normalizeEmail,
} from '../lib/enrollment';

type ProcessingStage =
    | 'IDLE'
    | 'ACCOUNT'
    | 'PROFILE'
    | 'CUSTOMER'
    | 'BILLING'
    | 'FINALIZING'
    | 'COMPLETE'
    | 'ERROR';

const FieldError: React.FC<{ message?: string }> = ({ message }) => (
    message
        ? <p className="mt-1 text-xs font-semibold text-red-600" role="alert">{message}</p>
        : null
);

const PublicRegistration: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const submitLockRef = useRef(false);
    // Steps: PAYMENT_SELECTION -> FORM -> ENROLLMENT -> ENROLLMENT_PAYMENT -> CONTRACT -> SUCCESS
    const [step, setStep] = useState<'PAYMENT_SELECTION' | 'FORM' | 'ENROLLMENT' | 'ENROLLMENT_PAYMENT' | 'CONTRACT' | 'SUCCESS'>('PAYMENT_SELECTION');
    const [enrollmentPix, setEnrollmentPix] = useState<{
        code: string;
        qrCode: string;
        paymentId: string;
        kind: 'ENROLLMENT_FEE' | 'ONE_TIME';
        billingType: 'PIX' | 'BOLETO';
        invoiceUrl?: string;
        amount: number;
    } | null>(null);
    const [checkingPayment, setCheckingPayment] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [processingStage, setProcessingStage] = useState<ProcessingStage>('IDLE');
    const [correlationId, setCorrelationId] = useState<string>('');
    const [resumeAuthenticated, setResumeAuthenticated] = useState(false);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [contractData, setContractData] = useState<any>(null);
    const [school, setSchool] = useState<SchoolInfo | null>(null);
    // Signature Data for PDF
    const [signatureData, setSignatureData] = useState<{ acceptedAt: string; ip: string; subId: string } | null>(null);
    const [signedPdfUrl, setSignedPdfUrl] = useState<string>('');

    // Form Fields
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirmation, setPasswordConfirmation] = useState('');
    const [showPassword, setShowPassword] = useState(false);
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
    const quote = calculateEnrollmentQuote(contractData);

    // Matrícula de dependente: no contrato, o CONTRATANTE é o responsável financeiro
    // e o aluno (quem preenche o link) aparece como beneficiário.
    const isDependentLink = !!contractData?.isDependent;
    const contratanteName = isDependentLink ? (contractData?.guardianName || name) : name;
    const contratanteCpf = isDependentLink ? (contractData?.guardianCpf || '') : cpf;
    const beneficiaryName = isDependentLink ? name : undefined;
    const contratanteEmail = isDependentLink ? (contractData?.guardianEmail || '') : email;
    const contratantePhone = isDependentLink ? (contractData?.guardianPhone || phone) : phone;
    const contratanteAddress = isDependentLink
        ? `${contractData?.guardianAddress || address}, ${contractData?.guardianAddressNumber || addressNumber} - ${contractData?.guardianPostalCode || postalCode}`
        : `${address}, ${addressNumber} - ${postalCode}`;

    // Contract Printing Logic
    const contractRef = useRef<HTMLDivElement>(null);
    const handlePrintContract = useReactToPrint({
        contentRef: contractRef,
        documentTitle: `Contrato_WiseWolf_${name ? name.replace(/\s+/g, '_') : 'Aluno'}`,
    });

    // Calculate dynamic dates based on Due Day and optional Start Date
    const getContractDates = () => {
        const duration = contractData?.planDuration ?? 12;

        let start: Date;
        
        if (contractData?.startDate) {
            // Use the specific start date provided in the link
            start = new Date(contractData.startDate + 'T12:00:00'); // Midday to avoid TZ issues
        } else {
            // A mesma data normalizada usada no resumo financeiro evita divergência
            // em fevereiro e nos vencimentos 29/30/31.
            start = new Date(`${quote.firstDueDate}T12:00:00`);
        }

        const end = new Date(start);
        end.setMonth(start.getMonth() + duration);

        return {
            startDate: start.toLocaleDateString('pt-BR'),
            endDate: end.toLocaleDateString('pt-BR')
        };
    };

    useEffect(() => {
        // Decode Query Params
        const params = new URLSearchParams(window.location.search);
        const encodedData = params.get('data');

        const offerId = params.get('offer');

        // Aplica o payload da matrícula no estado (compartilhado pelos caminhos
        // offer assinado e base64 legado).
        const hydrate = (data: any) => {
            setContractData({
                ...data,
                classSchedule: data.classSchedule || data.schedule || [],
                requiresEnrollment: data.requiresEnrollment !== false // default true
            });
            // A oferta segura já inclui os dados jurídicos; links legados usam o fallback.
            if (data._schoolInfo) setSchool(data._schoolInfo as SchoolInfo);
            else if (data.unitId) getSchoolInfo(data.unitId).then(setSchool);
            // Matrícula vinculada: contrato/cobrança usa os dados do RESPONSÁVEL.
            if (data.isDependent) {
                if (data.guardianPhone) setPhone(String(data.guardianPhone));
                if (data.guardianPostalCode) setPostalCode(String(data.guardianPostalCode));
                if (data.guardianAddress) setAddress(String(data.guardianAddress));
                if (data.guardianAddressNumber) setAddressNumber(String(data.guardianAddressNumber));
            }
            // Pre-fill de experimental, se houver
            if (data.studentName) setName(prev => prev || data.studentName);
            if (data.studentPhone) setPhone(prev => prev || data.studentPhone);
        };

        // Caminho seguro (novo): o preço/cobrança vem do SERVIDOR (offer), não do URL.
        if (offerId) {
            (async () => {
                let payload: Record<string, unknown>;
                try {
                    payload = await tenantLegalAssetsService.enrollmentOffer(offerId);
                } catch {
                    setError("Link de matrícula inválido, já utilizado ou expirado. Solicite um novo à escola.");
                    return;
                }
                hydrate(payload); // payload já traz _offerId → consume_offer roda no submit

                // Se esta sessão já iniciou a oferta, restaura os dados e leva o
                // aluno ao ponto correto sem persistir senha ou cartão.
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;

                const { data: progress } = await supabase.rpc('get_enrollment_progress', {
                    p_offer_id: offerId,
                });
                if (!progress?.success || progress.status === 'NOT_STARTED') return;

                const saved = progress.profile || {};
                setResumeAuthenticated(true);
                setCorrelationId(String(progress.correlation_id || ''));
                setName(String(saved.full_name || payload.studentName || ''));
                setEmail(String(saved.email || session.user.email || ''));
                setPhone(String(saved.phone || payload.studentPhone || ''));
                if (saved.cpf) setCpf(formatCpf(String(saved.cpf)));
                setPostalCode(String(saved.postal_code || ''));
                setAddress(String(saved.address || ''));
                setAddressNumber(String(saved.address_number || ''));
                if (['PIX', 'BOLETO', 'CREDIT_CARD'].includes(progress.billing_type)) {
                    setBillingType(progress.billing_type);
                }

                if (progress.status === 'COMPLETED') {
                    setProcessingStage('COMPLETE');
                    setStep('SUCCESS');
                    return;
                }

                if (progress.status === 'AWAITING_PAYMENT') {
                    try {
                        if (Number(payload.enrollmentFee || 0) > 0) {
                            const resumedPix = await asaasService.createEnrollmentPix();
                            setEnrollmentPix({
                                code: String(resumedPix.pixCode || ''),
                                qrCode: String(resumedPix.qrCode || ''),
                                paymentId: String(resumedPix.paymentId || ''),
                                kind: 'ENROLLMENT_FEE',
                                billingType: 'PIX',
                                amount: Number(payload.enrollmentFee),
                            });
                        } else if (Number(payload.planDuration) === 0) {
                            const resumedPayment = await asaasService.createSubscription({
                                user_id: session.user.id,
                                value: Number(payload.value),
                                dueDay: Number(payload.dueDay),
                                billingType: progress.billing_type || 'PIX',
                                planDuration: 'ONE_TIME',
                            });
                            setEnrollmentPix({
                                code: String(resumedPayment.pixCode || ''),
                                qrCode: String(resumedPayment.qrCode || ''),
                                paymentId: String(resumedPayment.payment_id || resumedPayment.id || ''),
                                kind: 'ONE_TIME',
                                billingType: progress.billing_type || 'PIX',
                                invoiceUrl: resumedPayment.invoice_url || undefined,
                                amount: Number(payload.value),
                            });
                        }
                        setStep('ENROLLMENT_PAYMENT');
                    } catch {
                        console.error('Não foi possível restaurar a cobrança pendente.');
                        setError('Sua matrícula foi salva. Não foi possível carregar a cobrança agora; tente novamente em alguns instantes.');
                    }
                    return;
                }

                setError(
                    progress.status === 'FAILED_RETRYABLE'
                        ? 'Sua matrícula foi salva até a última etapa concluída. Revise os dados e clique novamente para continuar.'
                        : null
                );
                setStep('FORM');
            })();
            return;
        }

        // Links antigos carregavam preco e cobranca em base64, portanto podiam ser
        // alterados no navegador. Eles precisam ser regenerados pela escola.
        if (encodedData) {
            setError("Este link de matrícula é antigo e precisa ser regenerado pela escola.");
        } else {
            setError("Link de matrícula inválido. Solicite um novo link à escola.");
        }
    }, []);

    const validateForm = () => {
        const nextErrors: Record<string, string> = {};
        const normalizedPhone = digitsOnly(phone);
        const normalizedCep = digitsOnly(postalCode);

        if (name.trim().split(/\s+/).length < 2) {
            nextErrors.name = 'Informe nome e sobrenome.';
        }
        if (!contractData?.isDependent && !isValidCpf(cpf)) {
            nextErrors.cpf = 'Informe um CPF válido.';
        }
        if (!contractData?.isDependent && !isValidBrazilianMobile(normalizedPhone)) {
            nextErrors.phone = 'Informe um celular válido com DDD.';
        }
        if (!contractData?.isDependent && normalizedCep.length !== 8) {
            nextErrors.postalCode = 'Informe um CEP com 8 números.';
        }
        if (!contractData?.isDependent && address.trim().length < 5) {
            nextErrors.address = 'Informe o endereço completo.';
        }
        if (!contractData?.isDependent && !addressNumber.trim()) {
            nextErrors.addressNumber = 'Informe o número.';
        }
        if (!isValidEmail(email)) {
            nextErrors.email = 'Informe um e-mail válido.';
        }
        if (!resumeAuthenticated) {
            if (password.length < 8) {
                nextErrors.password = 'Use pelo menos 8 caracteres.';
            }
            if (password !== passwordConfirmation) {
                nextErrors.passwordConfirmation = 'As senhas não são iguais.';
            }
        }

        if (billingType === 'CREDIT_CARD') {
            if (!isValidCreditCardNumber(ccNumber)) {
                nextErrors.ccNumber = 'Confira o número do cartão.';
            }
            if (ccName.trim().split(/\s+/).length < 2) {
                nextErrors.ccName = 'Informe o nome completo do titular.';
            }
            if (!isValidCardExpiry(ccExpiry)) {
                nextErrors.ccExpiry = 'Informe uma validade futura no formato MM/AAAA.';
            }
            if (!/^\d{3,4}$/.test(digitsOnly(ccCcv))) {
                nextErrors.ccCcv = 'Informe um código de segurança válido.';
            }
        }

        setFieldErrors(nextErrors);
        return Object.keys(nextErrors).length === 0;
    };

    const sendCompletionNotifications = async (userId: string, enrollmentData: any) => {
        if (enrollmentData?.testMode === true) return;

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            const welcomeResponse = await fetch(`${FUNCTIONS_URL}/whatsapp-notificacao-matricula`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ student_id: userId })
            });
            const welcomeResult = await welcomeResponse.json().catch(() => ({}));
            if (!welcomeResponse.ok) {
                console.warn('Notificação de boas-vindas pendente:', welcomeResponse.status);
                return;
            }

            // O welcome é idempotente. Só o primeiro envio dispara também o aviso
            // administrativo, evitando duplicidade em refresh/retry.
            if (welcomeResult?.skipped !== 'test_fixture') {
                const { error: directorNotificationError } = await supabase.functions.invoke('whatsapp-notificacao-wise', {
                    body: {
                        type: 'DIRECTOR_NEW_CONTRACT',
                        data: {
                            student_id: userId
                        }
                    }
                });
                if (directorNotificationError) {
                    console.warn('Aviso administrativo enfileirado com falha; será necessário reprocessar.');
                }
            }
        } catch {
            console.warn('Matrícula concluída; comunicação será tentada novamente.');
        }
    };

    const handleRegister = async (signatureDataObj?: {
        type: 'DIGITAL' | 'UPLOAD_SIG' | 'UPLOAD_DOC',
        url?: string,
        typedName?: string,
    }) => {
        if (!contractData) return;
        if (submitLockRef.current) return;
        submitLockRef.current = true;
        setLoading(true);
        setError(null);
        setProcessingStage('ACCOUNT');

        try {
            if (!contractData._offerId) {
                throw new Error('Este link de matrícula é antigo e precisa ser regenerado pela escola.');
            }

            let enrollmentData = contractData;

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

            // 1. Cria a conta ou entra na conta informada no formulário.
            // Nunca reutiliza silenciosamente uma sessão antiga de outra pessoa.
            let userId: string | null = null;
            const normalizedEmail = normalizeEmail(email);
            setEmail(normalizedEmail);

            const signInEnrollmentUser = async () => {
                const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                    email: normalizedEmail,
                    password
                });
                if (signInError || !signInData.user || !signInData.session) {
                    throw new Error('Este e-mail já está cadastrado ou aguarda confirmação. Verifique a senha/e-mail e tente novamente.');
                }
                return signInData.user.id;
            };

            let { data: currentSession } = await supabase.auth.getSession();
            const currentEmail = normalizeEmail(currentSession.session?.user.email || '');
            if (currentSession.session && currentEmail === normalizedEmail) {
                userId = currentSession.session.user.id;
                setResumeAuthenticated(true);
            } else {
                const { data: authData, error: authError } = await supabase.auth.signUp({
                    email: normalizedEmail,
                    password,
                    options: {
                        data: { full_name: name }
                    }
                });

                if (authError) {
                    if (authError.message.includes("already registered") || authError.message.includes("already exists")) {
                        userId = await signInEnrollmentUser();
                    } else {
                        throw authError;
                    }
                } else {
                    if (!authData.user) throw new Error("Erro ao criar usuário.");
                    userId = authData.user.id;
                    if (!authData.session) userId = await signInEnrollmentUser();
                }
            }

            ({ data: currentSession } = await supabase.auth.getSession());
            if (!currentSession.session || currentSession.session.user.id !== userId) {
                userId = await signInEnrollmentUser();
                ({ data: currentSession } = await supabase.auth.getSession());
            }
            if (!currentSession.session || currentSession.session.user.id !== userId) {
                throw new Error('Não foi possível confirmar a conta desta matrícula. Entre novamente e tente de novo.');
            }

            setProcessingStage('PROFILE');
            // Início atômico e retomável: grava perfil/aceite, mas ainda não fecha
            // link, oportunidade, indicação ou comissão.
            const { data: claimResult, error: claimError } = await supabase.rpc('begin_enrollment_offer', {
                p_offer_id: contractData._offerId,
                p_profile: {
                    full_name: name,
                    phone,
                    cpf,
                    postal_code: postalCode,
                    address,
                    address_number: addressNumber,
                    typed_signature: signatureDataObj?.typedName || '',
                    billing_type: billingType,
                    student_signature_url: signatureDataObj?.type === 'UPLOAD_SIG' ? signatureDataObj.url : null,
                    signed_document_url: signatureDataObj?.type === 'UPLOAD_DOC' ? signatureDataObj.url : null,
                }
            });

            if (claimError || !claimResult?.success || !claimResult?.payload) {
                console.error('Não foi possível iniciar ou retomar a oferta de matrícula.');
                if (claimResult?.error === 'PROFILE_ROLE_NOT_ALLOWED') {
                    throw new Error('Este e-mail pertence a uma conta da equipe. Use o e-mail pessoal do aluno para concluir a matrícula.');
                }
                if (claimResult?.error === 'INVALID_NAME') {
                    throw new Error('Informe o nome completo do aluno.');
                }
                if (claimResult?.error === 'INVALID_PHONE') {
                    throw new Error('Informe um WhatsApp válido com DDD.');
                }
                if (claimResult?.error === 'INVALID_CPF') {
                    throw new Error('Informe um CPF válido com 11 dígitos.');
                }
                if (claimResult?.error === 'CPF_ALREADY_REGISTERED') {
                    throw new Error('Este CPF já possui cadastro nesta escola. Entre com a conta existente ou fale com o suporte.');
                }
                if (claimResult?.error === 'INVALID_SIGNATURE') {
                    throw new Error('A assinatura deve corresponder exatamente ao nome do contratante.');
                }
                if (claimResult?.error === 'OFFER_IN_PROGRESS') {
                    throw new Error('Esta matrícula já foi iniciada por outra conta. Fale com a escola para recuperar o acesso.');
                }
                throw new Error('Não foi possível reservar este link. Ele pode estar expirado ou já concluído.');
            }
            setCorrelationId(String(claimResult.correlation_id || ''));

            enrollmentData = {
                ...contractData,
                ...claimResult.payload,
                classSchedule: claimResult.payload.classSchedule || claimResult.payload.schedule || [],
                requiresEnrollment: claimResult.payload.requiresEnrollment !== false,
            };
            setContractData(enrollmentData);

            const durationEnum = enrollmentData.planDuration === 0
                ? 'ONE_TIME'
                : enrollmentData.planDuration === 12
                    ? 'ANNUAL'
                    : enrollmentData.planDuration === 6
                        ? 'SEMESTER'
                        : 'RECURRENT';

            // Matrícula de dependente: cobrança no CPF do responsável financeiro.
            // O aluno tem perfil/login próprios; profiles.cpf fica NULL e o CPF de
            // cobrança vai em guardian_cpf (não viola profiles_cpf_tenant_key).
            const isDependent = !!enrollmentData.isDependent;
            const guardianCpf = isDependent ? String(enrollmentData.guardianCpf || '').replace(/\D/g, '') : null;

            // 2.1 AUTOMATIC SCHEDULING & PROFESSOR ASSIGNMENT
            // Bookings e professores são associados no servidor durante o sync.

            setProcessingStage('CUSTOMER');
            // 3. Sync with Asaas (+ full profile data via service role)
            const syncResponse = await asaasService.syncStudent({
                user_id: userId,
                name: name,
                email: normalizedEmail,
                phone: phone,
                cpf: isDependent ? '' : cpf.replace(/\D/g, ''),
                postalCode: postalCode,
                address: address,
                addressNumber: addressNumber,
                // Dependente: cobrança no CPF do responsável (cria customer ASAAS novo)
                is_dependent: isDependent,
                guardian_cpf: guardianCpf || undefined,
                guardian_name: enrollmentData.guardianName || undefined,
                guardian_email: enrollmentData.guardianEmail || undefined,
                guardian_phone: enrollmentData.guardianPhone || undefined,
                guardian_id: enrollmentData.guardianId || undefined,
                // Extended profile fields (saved server-side with service role, bypasses RLS)
                tenant_id: enrollmentData.unitId,
                monthly_fee: enrollmentData.value,
                due_day: enrollmentData.dueDay,
                class_frequency: `${enrollmentData.classesPerWeek}x`,
                professor_id: enrollmentData.professorId || null,
                professor_id_2: enrollmentData.professorId2 || null,
                classSchedule: enrollmentData.classSchedule || [],
                contract_accepted: true,
                documentation_status: 'APPROVED',
                signature_ip: signatureDataObj?.type === 'DIGITAL' ? 'Via Web (Digital)' : `Via Web (${signatureDataObj?.type})`,
                student_signature_url: signatureDataObj?.type === 'UPLOAD_SIG' ? signatureDataObj.url : null,
                signed_document_url: signatureDataObj?.type === 'UPLOAD_DOC' ? signatureDataObj.url : null,
                startDate: enrollmentData.startDate || null,
            });

            setProcessingStage('BILLING');
            // 4. Create Subscription (THE MOMENT OF TRUTH)
            const response = await asaasService.createSubscription({
                user_id: userId,
                customer: syncResponse?.asaas_customer_id,
                value: enrollmentData.value,
                dueDay: enrollmentData.dueDay,
                billingType: billingType,
                planDuration: durationEnum,
                // Passa o mês de início da cobrança (billingStartMonth) e pro-rata
                // para que o Asaas calcule o nextDueDate correto
                startDate: enrollmentData.billingStartMonth || undefined,
                proRata: enrollmentData.enableProRata || false,
                proRataValue: enrollmentData.proRataValue || undefined,
                creditCard: creditCardData,
                creditCardHolderInfo: billingType === 'CREDIT_CARD' ? {
                    name: isDependent ? (enrollmentData.guardianName || name) : name,
                    email: isDependent ? (enrollmentData.guardianEmail || email) : email,
                    cpfCnpj: isDependent ? (guardianCpf || '') : cpf.replace(/\D/g, ''),
                    postalCode,
                    addressNumber,
                    phone: (isDependent && enrollmentData.guardianPhone ? String(enrollmentData.guardianPhone) : phone).replace(/\D/g, '') // Asaas prefers numbers only
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
            if (response.correlation_id) {
                setCorrelationId(String(response.correlation_id));
            }

            // Save Signature Data for PDF
            setSignatureData({
                acceptedAt: new Date().toISOString(),
                ip: 'Registrado no servidor',
                subId: confirmedSubId
            });

            if (signatureDataObj?.url) {
                setSignedPdfUrl(signatureDataObj.url);
            }

            if (enrollmentData.requiresEnrollment !== false && enrollmentData.enrollmentFee > 0) {
                try {
                    const res = await asaasService.createEnrollmentPix();
                    setEnrollmentPix({
                        code: res.pixCode,
                        qrCode: res.qrCode,
                        paymentId: res.paymentId,
                        kind: 'ENROLLMENT_FEE',
                        billingType: 'PIX',
                        amount: Number(enrollmentData.enrollmentFee),
                    });
                    setStep('ENROLLMENT_PAYMENT');
                } catch {
                    console.error("Não foi possível carregar o PIX da matrícula.");
                    throw new Error('Seus dados e contrato foram salvos, mas não foi possível carregar o PIX agora. Clique novamente para continuar.');
                }
            } else if (durationEnum === 'ONE_TIME' && response.enrollment_complete !== true) {
                const code = String(response.pixCode || '');
                const qrCode = String(response.qrCode || '');
                const invoiceUrl = String(response.invoice_url || '');

                if (billingType === 'PIX' && !code && !qrCode && !invoiceUrl) {
                    throw new Error('O pagamento foi criado, mas não foi possível carregar o PIX. Tente novamente.');
                }
                if (billingType === 'BOLETO' && !invoiceUrl) {
                    throw new Error('O pagamento foi criado, mas não foi possível carregar o boleto. Tente novamente.');
                }

                setEnrollmentPix({
                    code,
                    qrCode,
                    paymentId: confirmedSubId,
                    kind: 'ONE_TIME',
                    billingType,
                    invoiceUrl,
                    amount: Number(enrollmentData.value),
                });
                setStep('ENROLLMENT_PAYMENT');
            } else {
                if (response.enrollment_complete !== true) {
                    throw new Error('Sua cobrança foi criada e a conclusão está sendo confirmada. Clique novamente para consultar o andamento.');
                }
                setProcessingStage('FINALIZING');
                await sendCompletionNotifications(userId, enrollmentData);
                setProcessingStage('COMPLETE');
                setStep('SUCCESS');
            }

        } catch (err: any) {
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
            if (errorMessage.includes('asaas_not_configured')) {
                errorMessage = 'A integração financeira está temporariamente indisponível. Seus dados foram salvos; tente novamente em alguns instantes.';
            }
            if (
                errorMessage.includes('Edge Function returned') ||
                errorMessage.includes('non-2xx') ||
                errorMessage.includes('Failed to send a request')
            ) {
                errorMessage = 'Não foi possível concluir a etapa financeira agora. Seus dados foram preservados e você pode tentar novamente sem refazer a matrícula.';
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
                } catch {
                    console.error("Falha ao interpretar a resposta segura da etapa financeira.");
                }
            }

            try {
                const { data: progress } = await supabase.rpc('get_enrollment_progress', {
                    p_offer_id: contractData._offerId,
                });
                if (progress?.success && progress.status !== 'NOT_STARTED') {
                    setCorrelationId(String(progress.correlation_id || ''));
                    if (!errorMessage.includes('salv')) {
                        errorMessage = `Sua matrícula foi salva até a última etapa concluída. ${errorMessage}`;
                    }
                }
            } catch {
                // A mensagem original continua disponível mesmo se a consulta de
                // retomada também estiver temporariamente indisponível.
            }

            setProcessingStage('ERROR');
            setError(errorMessage);
        } finally {
            submitLockRef.current = false;
            setLoading(false);
        }
    };

    const openContract = async () => {
        const offerId = contractData?._offerId;
        if (typeof offerId === 'string') {
            try {
                const payload = await tenantLegalAssetsService.enrollmentOffer(offerId);
                setContractData((current: any) => ({
                    ...current,
                    ...payload,
                    classSchedule: (payload as any).classSchedule || (payload as any).schedule || current?.classSchedule || [],
                    requiresEnrollment: (payload as any).requiresEnrollment !== false,
                }));
                if ((payload as any)._schoolInfo) setSchool((payload as any)._schoolInfo as SchoolInfo);
            } catch {
                setError('Não foi possível liberar a assinatura privada do contrato. Solicite um novo link.');
                return;
            }
        }
        setStep('CONTRACT');
    };

    const handleFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!validateForm()) return;
        setError(null);
        // If requires enrollment (non-avulso), show enrollment form first
        if (contractData?.requiresEnrollment) {
            setStep('ENROLLMENT');
        } else {
            void openContract();
        }
    };

    const handleEnrollmentSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void openContract();
    };

    const handleCheckEnrollmentPayment = async () => {
        if (!enrollmentPix) return;
        setCheckingPayment(true);
        try {
            const res = enrollmentPix.kind === 'ONE_TIME'
                ? await (async () => {
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) return { success: false };
                    return asaasService.checkOneTimePayment(session.user.id);
                })()
                : await asaasService.checkPaymentStatus(enrollmentPix.paymentId);
            if (res?.paid === true || ['RECEIVED', 'CONFIRMED'].includes(res?.status)) {
                const { data: { session } } = await supabase.auth.getSession();
                setProcessingStage('FINALIZING');
                if (session) await sendCompletionNotifications(session.user.id, contractData);
                setProcessingStage('COMPLETE');
                setError(null);
                setStep('SUCCESS');
            } else {
                setError('Pagamento ainda não identificado. Se você já pagou, aguarde alguns instantes e consulte novamente.');
            }
        } catch {
            console.error('Falha temporária ao consultar o pagamento.');
            setError('Não foi possível consultar o pagamento agora. Sua matrícula continua salva; tente novamente em instantes.');
        } finally {
            setCheckingPayment(false);
        }
    };

    const renderFinancialSummary = () => (
        <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-left space-y-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-blue-900">Resumo financeiro</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <span className="text-blue-700">
                    {contractData?.planDuration === 0
                        ? 'Pagamento único'
                        : `${quote.installmentCount} mensalidades`}
                </span>
                <strong className="text-right text-blue-950">
                    {contractData?.planDuration === 0
                        ? formatBrl(quote.installmentValue)
                        : `${quote.installmentCount} × ${formatBrl(quote.installmentValue)}`}
                </strong>
                {quote.enrollmentFee > 0 && (
                    <>
                        <span className="text-blue-700">Taxa de matrícula via PIX</span>
                        <strong className="text-right text-blue-950">{formatBrl(quote.enrollmentFee)}</strong>
                    </>
                )}
                {quote.proRataValue > 0 && (
                    <>
                        <span className="text-blue-700">Valor proporcional inicial</span>
                        <strong className="text-right text-blue-950">{formatBrl(quote.proRataValue)}</strong>
                    </>
                )}
                {contractData?.planDuration !== 0 && (
                    <>
                        <span className="text-blue-700">Primeiro vencimento</span>
                        <strong className="text-right text-blue-950">{formatDateBr(quote.firstDueDate)}</strong>
                    </>
                )}
                <span className="border-t border-blue-200 pt-2 font-bold text-blue-900">Total do contrato</span>
                <strong className="border-t border-blue-200 pt-2 text-right text-blue-950">{formatBrl(quote.total)}</strong>
            </div>
            {quote.dueToday > 0 && (
                <p className="text-[11px] text-blue-800 pt-1">
                    Valor solicitado na conclusão de hoje: <strong>{formatBrl(quote.dueToday)}</strong>.
                </p>
            )}
        </div>
    );

    // ========== PAYMENT SELECTION STEP ==========
    if (step === 'PAYMENT_SELECTION') {
        if (!contractData && !error) {
            return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-brand-muted" /></div>;
        }

        if (!contractData && error) {
            return (
                <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4 font-sans">
                    <div className="max-w-md w-full bg-brand-surface rounded-[2.5rem] shadow-2xl border border-white p-10 text-center">
                        <AlertCircle className="text-red-500 mx-auto mb-5" size={48} />
                        <h1 className="text-2xl font-black text-brand-text mb-3">Link indisponível</h1>
                        <p className="text-sm text-brand-muted leading-relaxed">{error}</p>
                    </div>
                </div>
            );
        }

        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
                <div className="max-w-lg mx-auto bg-brand-surface rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                    {/* Header */}
                    <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                        <div className="relative z-10">
                            <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">Matrícula Online</h1>
                            {contractData && (
                                <div className="flex flex-col gap-2 items-center">
                                    <div className="inline-block bg-brand-surface/10 backdrop-blur-md border border-white/20 rounded-xl px-4 py-2">
                                        <p className="text-sm font-bold text-blue-100 uppercase tracking-widest">
                                            Plano {contractData.planDuration === 0 ? 'Avulso' : contractData.planDuration === 12 ? 'Anual' : contractData.planDuration === 6 ? 'Semestral' : 'Mensal'}
                                        </p>
                                    </div>
                                    <div className="inline-block bg-brand-surface px-4 py-1 rounded-full shadow-lg">
                                        <p className="text-sm font-black text-blue-900">
                                            {contractData.classesPerWeek}x na semana • R$ {Number(contractData.value).toFixed(2)}
                                            {contractData.planDuration === 0 ? ' (pagamento único)' : '/mês'}
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
                            <h2 className="text-xl font-black text-brand-text mb-2">Como você prefere pagar?</h2>
                            <p className="text-brand-muted text-sm">Selecione sua forma de pagamento para prosseguir com a matrícula.</p>
                        </div>

                        <div className="mb-6">{renderFinancialSummary()}</div>

                        <div className="grid grid-cols-1 gap-4">
                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('PIX');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-brand-border bg-brand-surface hover:border-emerald-500 hover:bg-emerald-50 hover:shadow-lg hover:shadow-emerald-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <QrCode size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-brand-text group-hover:text-emerald-700">Pix</h3>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('CREDIT_CARD');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-brand-border bg-brand-surface hover:border-blue-500 hover:bg-blue-50 hover:shadow-lg hover:shadow-blue-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <CreditCard size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-brand-text group-hover:text-blue-700">Cartão</h3>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setBillingType('BOLETO');
                                    setStep('FORM');
                                }}
                                className="flex items-center p-6 rounded-2xl border-2 border-brand-border bg-brand-surface hover:border-amber-500 hover:bg-amber-50 hover:shadow-lg hover:shadow-amber-500/10 transition-all group text-left"
                            >
                                <div className="w-16 h-16 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <Barcode size={32} />
                                </div>
                                <div className="ml-5">
                                    <h3 className="text-lg font-black text-brand-text group-hover:text-amber-700">Boleto</h3>
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
                <div className="max-w-lg mx-auto bg-brand-surface rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                    <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                        <div className="relative z-10 text-white">
                            <QrCode className="mx-auto mb-4" size={48} />
                            <h1 className="text-2xl font-black uppercase tracking-tight">
                                {enrollmentPix?.kind === 'ONE_TIME' ? 'Pagamento da Aula Avulsa' : 'Taxa de Matrícula'}
                            </h1>
                            <p className="text-blue-100/80 text-sm">Contrato Assinado com Sucesso! 📜</p>
                            <p className="text-blue-100/60 text-[10px] mt-1 uppercase font-bold tracking-widest">
                                {enrollmentPix?.kind === 'ONE_TIME'
                                    ? 'Conclua o pagamento para confirmar a aula'
                                    : 'Agora, pague a matrícula para garantir sua vaga'}
                            </p>
                        </div>
                    </div>

                    <div className="p-8 text-center space-y-6">
                        {error && (
                            <div role="status" aria-live="polite" className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-left flex gap-3">
                                <AlertCircle className="text-amber-600 shrink-0" size={20} />
                                <p className="text-sm font-semibold text-amber-800">{error}</p>
                            </div>
                        )}
                        <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-2xl inline-block">
                            <p className="text-xs font-bold text-emerald-600 uppercase tracking-widest mb-1">Valor a Pagar</p>
                            <p className="text-3xl font-black text-emerald-700">
                                R$ {Number(enrollmentPix?.amount || 0).toFixed(2)}
                            </p>
                        </div>

                        {enrollmentPix?.billingType === 'PIX' && enrollmentPix?.qrCode ? (
                            <div className="bg-brand-surface p-4 rounded-3xl border-4 border-slate-50 inline-block shadow-inner">
                                <img 
                                    src={`data:image/png;base64,${enrollmentPix.qrCode}`} 
                                    alt="Asaas Pix QR Code" 
                                    className="w-64 h-64 mx-auto"
                                />
                            </div>
                        ) : enrollmentPix?.billingType === 'PIX' && !enrollmentPix?.invoiceUrl ? (
                            <div className="h-64 flex items-center justify-center">
                                <Loader2 className="animate-spin text-slate-300" size={48} />
                            </div>
                        ) : null}

                        {enrollmentPix?.billingType === 'CREDIT_CARD' && (
                            <div className="p-5 rounded-2xl border border-blue-200 bg-blue-50 text-blue-800">
                                <CreditCard className="mx-auto mb-2" size={30} />
                                <p className="font-bold">Pagamento enviado para confirmação</p>
                                <p className="text-xs mt-1">A operadora pode levar alguns instantes para confirmar.</p>
                            </div>
                        )}

                        {enrollmentPix?.billingType === 'PIX' && enrollmentPix?.code && (
                        <div className="space-y-3">
                            <p className="text-xs font-bold text-brand-muted uppercase tracking-widest">Código Pix (Copia e Cola)</p>
                            <div className="flex gap-2">
                                <input 
                                    readOnly
                                    value={enrollmentPix?.code || ''}
                                    className="flex-1 bg-brand-surface-2 border border-brand-border rounded-xl px-4 py-3 text-xs font-mono text-brand-muted overflow-hidden text-ellipsis"
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
                        )}

                        {enrollmentPix?.invoiceUrl && (
                            <a
                                href={enrollmentPix.invoiceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all"
                            >
                                {enrollmentPix.billingType === 'BOLETO' ? 'Abrir boleto' : 'Abrir página de pagamento'}
                            </a>
                        )}

                        <div className="pt-6 border-t border-brand-border flex flex-col gap-3">
                            <button
                                onClick={handleCheckEnrollmentPayment}
                                disabled={checkingPayment}
                                className="w-full py-4 bg-[#002366] hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2"
                            >
                                {checkingPayment ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle size={18} />}
                                Consultar confirmação
                            </button>
                            <p className="text-[10px] text-brand-muted font-bold uppercase tracking-tight">
                                A confirmação pode levar até 30 segundos após o pagamento.
                            </p>
                            {correlationId && (
                                <p className="text-[10px] text-brand-muted">
                                    Protocolo: <span className="font-mono font-bold">{correlationId.slice(0, 8).toUpperCase()}</span>
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (step === 'ENROLLMENT') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
                <div className="max-w-lg mx-auto bg-brand-surface rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
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
                        <div className="bg-brand-surface-2 p-4 rounded-2xl border border-brand-border">
                            <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest mb-3 flex items-center gap-2">
                                <User size={14} /> Dados do Aluno
                            </h3>
                            <div className="space-y-2 text-sm text-brand-muted">
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
                                className="flex-1 py-4 bg-brand-surface-2 text-brand-muted rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
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
            <div className="min-h-screen bg-brand-surface-2 flex items-center justify-center p-4 font-sans">
                <div className="bg-brand-surface p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={40} className="text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-black text-brand-text mb-2">Matrícula Confirmada!</h2>
                    <p className="text-brand-muted mb-6">
                        Seu acesso ao portal foi criado e o fluxo financeiro foi confirmado.
                    </p>
                    {correlationId && (
                        <div className="mb-6 rounded-xl bg-brand-surface-2 border border-brand-border px-4 py-3">
                            <p className="text-[10px] uppercase tracking-widest font-bold text-brand-muted">Protocolo da matrícula</p>
                            <p className="font-mono font-black text-brand-text">{correlationId.slice(0, 8).toUpperCase()}</p>
                        </div>
                    )}
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
                            className="block w-full px-8 py-3 bg-brand-surface border border-brand-border text-brand-muted rounded-xl font-bold uppercase tracking-widest hover:bg-brand-surface-2 transition-colors flex items-center justify-center gap-2"
                        >
                            <Download size={18} /> Baixar Contrato Assinado
                        </button>
                        */}
                    </div>

                    {/* Hidden Contract Form for PDF Printing */}
                    <div className="hidden">
                        <div ref={contractRef}>
                            <ContractDocument
                                studentName={contratanteName}
                                studentCPF={(contratanteCpf || '').replace(/\D/g, '')}
                                dependentName={beneficiaryName}
                                studentAddress={contratanteAddress}
                                studentEmail={contratanteEmail}
                                studentPhone={contratantePhone}
                                planName={`Plano ${contractData.planDuration === 0 ? 'Avulso' : contractData.planDuration === 12 ? 'Anual' : contractData.planDuration === 6 ? 'Semestral' : 'Mensal'}`}
                                planValue={Number(contractData.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                totalValue={quote.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                planDuration={contractData.planDuration ?? 12}
                                startDate={getContractDates().startDate}
                                endDate={getContractDates().endDate}
                                dueDay={contractData.dueDay || 10}
                                classFrequency={contractData.classesPerWeek || 2}
                                enrollmentFee={quote.enrollmentFee}
                                proRataValue={quote.proRataValue}
                                acceptedAt={signatureData?.acceptedAt}
                                userIp={signatureData?.ip}
                                subscriptionId={signatureData?.subId}
                                school={school || undefined}
                            />
                        </div>
                    </div>

                </div>
            </div>
        );
    }

    if (!contractData && !error) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-brand-muted" /></div>;
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 py-12 px-4 font-sans">
            <div className="max-w-lg mx-auto bg-brand-surface rounded-[2.5rem] shadow-2xl overflow-hidden border border-white">
                {/* Header */}
                <div className="bg-[#002366] p-8 text-center relative overflow-hidden">
                    <div className="relative z-10">
                        <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">Matrícula Online</h1>
                        {contractData && (
                            <div className="flex flex-col gap-2 items-center">
                                <div className="inline-block bg-brand-surface/10 backdrop-blur-md border border-white/20 rounded-xl px-4 py-2">
                                    <p className="text-sm font-bold text-blue-100 uppercase tracking-widest">
                                        Plano {contractData.planDuration === 0 ? 'Avulso' : contractData.planDuration === 12 ? 'Anual' : contractData.planDuration === 6 ? 'Semestral' : 'Mensal'}
                                    </p>
                                </div>
                                <div className="inline-block bg-brand-surface px-4 py-1 rounded-full shadow-lg">
                                    <p className="text-sm font-black text-blue-900">
                                        {contractData.classesPerWeek}x na semana • R$ {Number(contractData.value).toFixed(2)}
                                        {contractData.planDuration === 0 ? ' (pagamento único)' : '/mês'}
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

                    <form onSubmit={handleFormSubmit} className="space-y-6" noValidate>
                        {renderFinancialSummary()}
                        {/* 1. Payment Method Overview */}
                        <div className="space-y-3 relative">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2">
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
                                <div className="bg-brand-surface-2 p-4 rounded-2xl border border-brand-border space-y-4 animate-in fade-in duration-300">
                                    <div className="flex items-center justify-center gap-2 text-emerald-600 mb-2">
                                        <Lock size={12} />
                                        <span className="text-[10px] uppercase font-black tracking-widest">Ambiente Seguro (SSL)</span>
                                    </div>

                                    <div className="space-y-4">
                                        <div>
                                            <input
                                                type="tel"
                                                inputMode="numeric"
                                                autoComplete="cc-number"
                                                placeholder="Número do Cartão"
                                                value={ccNumber}
                                                onChange={e => {
                                                    const value = digitsOnly(e.target.value).slice(0, 19);
                                                    setCcNumber(value.replace(/(\d{4})(?=\d)/g, '$1 '));
                                                }}
                                                aria-invalid={Boolean(fieldErrors.ccNumber)}
                                                className="w-full px-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-brand-muted"
                                            />
                                            <FieldError message={fieldErrors.ccNumber} />
                                        </div>
                                        <div>
                                            <input
                                                type="text"
                                                autoComplete="cc-name"
                                                placeholder="Nome Impresso no Cartão"
                                                value={ccName}
                                                onChange={e => setCcName(e.target.value)}
                                                aria-invalid={Boolean(fieldErrors.ccName)}
                                                className="w-full px-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-brand-muted"
                                            />
                                            <FieldError message={fieldErrors.ccName} />
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div>
                                                <input
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
                                                    aria-invalid={Boolean(fieldErrors.ccExpiry)}
                                                    className="w-full px-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-brand-muted"
                                                />
                                                <FieldError message={fieldErrors.ccExpiry} />
                                            </div>
                                            <div>
                                                <input
                                                    type="tel"
                                                    inputMode="numeric"
                                                    autoComplete="cc-csc"
                                                    placeholder="CVV"
                                                    value={ccCcv}
                                                    onChange={e => setCcCcv(digitsOnly(e.target.value).slice(0, 4))}
                                                    maxLength={4}
                                                    aria-invalid={Boolean(fieldErrors.ccCcv)}
                                                    className="w-full px-4 py-3 bg-brand-surface border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-brand-muted"
                                                />
                                                <FieldError message={fieldErrors.ccCcv} />
                                            </div>
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
                            <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2">
                                <User size={14} /> Dados Pessoais
                            </h3>

                            <div>
                                <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-name">Nome completo</label>
                                <input
                                    id="enrollment-name"
                                    placeholder="Nome e sobrenome"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    aria-invalid={Boolean(fieldErrors.name)}
                                    className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                />
                                <FieldError message={fieldErrors.name} />
                            </div>

                            {contractData?.isDependent ? (
                                <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-[11px] text-blue-800 leading-relaxed">
                                    <strong>Matrícula vinculada.</strong> O contrato e a cobrança são feitos no nome e CPF do responsável
                                    {contractData?.guardianName ? <> (<strong>{contractData.guardianName}</strong>)</> : ''} — incluindo WhatsApp e endereço dele.
                                    Você só precisa informar <strong>o nome do aluno</strong> (acima) e os <strong>dados de acesso</strong> (abaixo).
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-cpf">CPF</label>
                                        <input
                                            id="enrollment-cpf"
                                            inputMode="numeric"
                                            autoComplete="off"
                                            placeholder="000.000.000-00"
                                            value={cpf}
                                            onChange={e => setCpf(formatCpf(e.target.value))}
                                            aria-invalid={Boolean(fieldErrors.cpf)}
                                            className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                        />
                                        <FieldError message={fieldErrors.cpf} />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-phone">WhatsApp com DDD</label>
                                        <input
                                            id="enrollment-phone"
                                            inputMode="tel"
                                            autoComplete="tel"
                                            placeholder="(00) 00000-0000"
                                            value={phone}
                                            onChange={e => {
                                                let v = e.target.value.replace(/\D/g, '');
                                                if (v.length > 11) v = v.substring(0, 11);
                                                if (v.length > 2) v = `(${v.substring(0, 2)}) ${v.substring(2)}`;
                                                if (v.length > 10) v = `${v.substring(0, 10)}-${v.substring(10)}`;
                                                setPhone(v);
                                            }}
                                            aria-invalid={Boolean(fieldErrors.phone)}
                                            className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                        />
                                        <FieldError message={fieldErrors.phone} />
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* 3. Address — oculto em matrícula vinculada (usa o endereço do responsável) */}
                        {!contractData?.isDependent && (
                        <div className="space-y-4 pt-2">
                            <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2">
                                <MapPin size={14} /> Endereço
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div className="col-span-1">
                                    <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-cep">CEP</label>
                                    <input
                                        id="enrollment-cep"
                                        inputMode="numeric"
                                        autoComplete="postal-code"
                                        placeholder="00000-000"
                                        value={postalCode}
                                        onChange={e => {
                                            const value = digitsOnly(e.target.value).slice(0, 8);
                                            setPostalCode(value.length > 5 ? `${value.slice(0, 5)}-${value.slice(5)}` : value);
                                        }}
                                        aria-invalid={Boolean(fieldErrors.postalCode)}
                                        className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                    />
                                    <FieldError message={fieldErrors.postalCode} />
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-number">Número</label>
                                    <input
                                        id="enrollment-number"
                                        autoComplete="address-line2"
                                        placeholder="Número ou S/N"
                                        value={addressNumber}
                                        onChange={e => setAddressNumber(e.target.value)}
                                        aria-invalid={Boolean(fieldErrors.addressNumber)}
                                        className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                    />
                                    <FieldError message={fieldErrors.addressNumber} />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-address">Endereço completo</label>
                                <input
                                    id="enrollment-address"
                                    autoComplete="street-address"
                                    placeholder="Rua, bairro e cidade"
                                    value={address}
                                    onChange={e => setAddress(e.target.value)}
                                    aria-invalid={Boolean(fieldErrors.address)}
                                    className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                />
                                <FieldError message={fieldErrors.address} />
                            </div>
                        </div>
                        )}

                        {/* 4. Credentials */}
                        <div className="space-y-4 pt-2">
                            <h3 className="text-xs font-black text-brand-muted uppercase tracking-widest flex items-center gap-2">
                                <Lock size={14} /> Acesso ao Portal
                            </h3>
                            <div>
                                <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-email">E-mail de acesso</label>
                                <input
                                    id="enrollment-email"
                                    type="email"
                                    autoComplete="email"
                                    placeholder="voce@exemplo.com"
                                    value={email}
                                    readOnly={resumeAuthenticated}
                                    onChange={e => setEmail(e.target.value)}
                                    aria-invalid={Boolean(fieldErrors.email)}
                                    className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted read-only:opacity-70"
                                />
                                <FieldError message={fieldErrors.email} />
                            </div>
                            {resumeAuthenticated ? (
                                <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
                                    <CheckCircle size={18} className="shrink-0 mt-0.5" />
                                    <p className="text-xs font-semibold">Conta confirmada. Você continuará exatamente da etapa salva.</p>
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-password">Crie uma senha</label>
                                        <div className="relative">
                                            <input
                                                id="enrollment-password"
                                                type={showPassword ? 'text' : 'password'}
                                                autoComplete="new-password"
                                                placeholder="Mínimo de 8 caracteres"
                                                value={password}
                                                onChange={e => setPassword(e.target.value)}
                                                aria-invalid={Boolean(fieldErrors.password)}
                                                className="w-full px-5 py-4 pr-12 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowPassword(value => !value)}
                                                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                                                className="absolute right-4 top-1/2 -translate-y-1/2 text-brand-muted"
                                            >
                                                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                            </button>
                                        </div>
                                        <FieldError message={fieldErrors.password} />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-brand-muted mb-1" htmlFor="enrollment-password-confirmation">Confirme a senha</label>
                                        <input
                                            id="enrollment-password-confirmation"
                                            type={showPassword ? 'text' : 'password'}
                                            autoComplete="new-password"
                                            placeholder="Digite novamente"
                                            value={passwordConfirmation}
                                            onChange={e => setPasswordConfirmation(e.target.value)}
                                            aria-invalid={Boolean(fieldErrors.passwordConfirmation)}
                                            className="w-full px-5 py-4 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text focus:ring-2 focus:ring-[#002366] outline-none transition-all placeholder:text-brand-muted"
                                        />
                                        <FieldError message={fieldErrors.passwordConfirmation} />
                                    </div>
                                </>
                            )}
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-5 bg-[#002366] hover:bg-[#001844] text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-2 mt-6 disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                            {loading ? <Loader2 className="animate-spin" /> : <>Revisar e assinar <ArrowRight size={18} /></>}
                        </button>

                        <p className="text-center text-[10px] text-brand-muted font-medium">
                            Na próxima etapa você poderá ler o contrato antes de assinar.
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
                    studentName={contratanteName.toUpperCase()}
                    studentCPF={contratanteCpf}
                    dependentName={beneficiaryName}
                    studentAddress={contratanteAddress}
                    studentEmail={contratanteEmail}
                    studentPhone={contratantePhone}
                    planName={contractData.planDuration === 0 ? 'Plano Avulso' : contractData.planDuration === 12 ? 'Plano Anual' : contractData.planDuration === 6 ? 'Plano Semestral' : 'Plano Mensal'}
                    planValue={Number(contractData.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    totalValue={quote.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    planDuration={contractData.planDuration ?? 12}
                    startDate={getContractDates().startDate}
                    endDate={getContractDates().endDate}
                    dueDay={contractData.dueDay || 10}
                    classFrequency={contractData.classesPerWeek || 2}
                    school={school || undefined}
                    enrollmentFee={quote.enrollmentFee}
                    proRataValue={quote.proRataValue}
                    dueToday={quote.dueToday}
                    firstDueDate={formatDateBr(quote.firstDueDate)}
                    processingStage={processingStage}
                    processingError={error}
                    correlationId={correlationId}
                />
            )}

            {/* Hidden Contract for Printing - Moved outside conditional render */}
            <div style={{ position: 'absolute', top: '-9999px', left: '-9999px' }}>
                <div ref={contractRef}>
                    <ContractDocument
                        studentName={contratanteName.toUpperCase()}
                        studentCPF={contratanteCpf}
                        dependentName={beneficiaryName}
                        studentAddress={contratanteAddress}
                        studentEmail={contratanteEmail}
                        studentPhone={contratantePhone}
                        planName={contractData?.planDuration === 0 ? 'Plano Avulso' : contractData?.planDuration === 12 ? 'Plano Anual' : contractData?.planDuration === 6 ? 'Plano Semestral' : 'Plano Mensal'}
                        planValue={Number(contractData?.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        totalValue={quote.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        planDuration={contractData?.planDuration ?? 12}
                        startDate={getContractDates().startDate}
                        endDate={getContractDates().endDate}
                        dueDay={contractData?.dueDay || 10}
                        classFrequency={contractData?.classesPerWeek || 2}
                        enrollmentFee={quote.enrollmentFee}
                        proRataValue={quote.proRataValue}
                        acceptedAt={signatureData?.acceptedAt}
                        userIp={signatureData?.ip}
                        subscriptionId={signatureData?.subId}
                        school={school || undefined}
                    />
                </div>
            </div>
        </div>
    );
};

export default PublicRegistration;
