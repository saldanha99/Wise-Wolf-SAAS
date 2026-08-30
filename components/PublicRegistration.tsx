import React, { useState, useEffect, useRef } from 'react';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { ContractDocument, type SchoolInfo } from './ContractDocument';
import { getSchoolInfo } from '../lib/schoolInfo';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';
import ContractModal from './ContractModal';
import { useReactToPrint } from 'react-to-print';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Barcode,
    CalendarDays,
    Check,
    CheckCircle,
    ChevronRight,
    Clock3,
    CreditCard,
    Eye,
    EyeOff,
    FileText,
    Loader2,
    Lock,
    MapPin,
    QrCode,
    ReceiptText,
    ShieldCheck,
    Sparkles,
    User,
    type LucideIcon,
} from 'lucide-react';
import './PublicRegistration.css';
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
    normalizeEnrollmentProRataTerms,
    normalizeEmail,
} from '../lib/enrollment';
import {
    classifyEnrollmentPaymentOutcome,
    classifyEnrollmentProgressOutcome,
    getEnrollmentConfirmationSource,
    getPendingEnrollmentPaymentKind,
    getPendingEnrollmentPaymentPresentation,
    type PendingEnrollmentPaymentKind,
} from '../lib/enrollmentPaymentOutcome';
import { addCalendarMonthsClamped } from '../lib/contractDates';

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

const ENROLLMENT_STEPS = ['Pagamento', 'Seus dados', 'Contrato', 'Conclusão'] as const;

type EnrollmentQuote = ReturnType<typeof calculateEnrollmentQuote>;

interface EnrollmentShellProps {
    children: React.ReactNode;
    currentStep: 1 | 2 | 3 | 4;
    storyTitle: React.ReactNode;
    storyDescription: string;
    contractData?: any;
    quote?: EnrollmentQuote;
    school?: SchoolInfo | null;
    isFinished?: boolean;
}

const planLabel = (duration?: number) => {
    if (duration === 0) return 'Plano Avulso';
    if (duration === 12) return 'Plano Anual';
    if (duration === 6) return 'Plano Semestral';
    return 'Plano Mensal';
};

const EnrollmentShell: React.FC<EnrollmentShellProps> = ({
    children,
    currentStep,
    storyTitle,
    storyDescription,
    contractData,
    quote,
    school,
    isFinished = false,
}) => {
    const schoolName = school?.name || school?.legalName || 'Wise Wolf Languages';
    const duration = Number(contractData?.planDuration ?? 12);
    const progress = isFinished ? 1 : (currentStep - 1) / (ENROLLMENT_STEPS.length - 1);
    const progressStyle = { '--enrollment-progress': progress } as React.CSSProperties;

    return (
        <div className="enrollment-experience">
            <header className="enrollment-topbar">
                <div className="enrollment-brand" aria-label={`${schoolName}, matrícula online`}>
                    <span className="enrollment-brand__mark" aria-hidden="true">WW</span>
                    <span>
                        <span className="enrollment-brand__name">{schoolName}</span>
                        <span className="enrollment-brand__caption">Matrícula online</span>
                    </span>
                </div>
                <div className="enrollment-secure-chip">
                    <ShieldCheck size={16} aria-hidden="true" />
                    <span>Ambiente protegido</span>
                </div>
            </header>

            <main className="enrollment-layout">
                <aside className="enrollment-story" aria-label="Resumo da sua jornada">
                    <div className="enrollment-story__content">
                        <img
                            src="/assets/wolfie/brand/wise-wolf-logo-horizontal-dark.png"
                            alt="Wise Wolf"
                            className="h-10 w-auto max-w-[152px] object-contain"
                        />
                        <p className="enrollment-story__eyebrow mt-8">
                            <Sparkles size={14} aria-hidden="true" />
                            Sua jornada começa aqui
                        </p>
                        <h1 className="enrollment-story__title">{storyTitle}</h1>
                        <p className="enrollment-story__description">{storyDescription}</p>

                        {contractData && quote ? (
                            <div className="enrollment-plan-spotlight">
                                <div className="enrollment-plan-spotlight__top">
                                    <div>
                                        <p className="enrollment-plan-spotlight__label">Seu plano</p>
                                        <p className="enrollment-plan-spotlight__name">{planLabel(duration)}</p>
                                    </div>
                                    <div className="enrollment-plan-spotlight__price">
                                        <strong>{formatBrl(Number(contractData.value || 0))}</strong>
                                        <span>{duration === 0 ? 'pagamento único' : 'por mês'}</span>
                                    </div>
                                </div>
                                <div className="enrollment-plan-spotlight__meta">
                                    <span>
                                        <Clock3 size={14} aria-hidden="true" />
                                        {contractData.classesPerWeek
                                            ? `${contractData.classesPerWeek}x por semana`
                                            : 'Jornada personalizada'}
                                    </span>
                                    <span>
                                        <CalendarDays size={14} aria-hidden="true" />
                                        {duration === 0 ? 'Aula avulsa' : `${duration} meses`}
                                    </span>
                                </div>
                            </div>
                        ) : null}

                        <div className="enrollment-story__trust" aria-label="Garantias da matrícula">
                            <span><Check size={15} aria-hidden="true" /> Você revisa tudo antes de assinar</span>
                            <span><Check size={15} aria-hidden="true" /> Pagamento processado via Asaas</span>
                            <span><Check size={15} aria-hidden="true" /> Contrato com trilha de auditoria</span>
                        </div>
                    </div>

                    <p className="enrollment-story__footer">
                        Uma experiência {schoolName} · segura do início ao fim
                    </p>
                </aside>

                <section className="enrollment-workspace" aria-label="Etapas da matrícula">
                    <nav className="enrollment-stepper" aria-label="Progresso da matrícula" style={progressStyle}>
                        <span className="enrollment-stepper__progress" aria-hidden="true" />
                        {ENROLLMENT_STEPS.map((label, index) => {
                            const number = index + 1;
                            const complete = isFinished || number < currentStep;
                            const active = !isFinished && number === currentStep;
                            return (
                                <span
                                    key={label}
                                    className={`enrollment-stepper__item${complete ? ' is-complete' : ''}${active ? ' is-active' : ''}`}
                                    aria-current={active ? 'step' : undefined}
                                >
                                    <span className="enrollment-stepper__number">
                                        {complete ? <Check size={14} aria-hidden="true" /> : number}
                                    </span>
                                    <span>{label}</span>
                                </span>
                            );
                        })}
                    </nav>
                    <div className="enrollment-panel">{children}</div>
                </section>
            </main>
        </div>
    );
};

interface PaymentOptionProps {
    icon: LucideIcon;
    title: string;
    description: string;
    variant: 'pix' | 'card' | 'boleto';
    onSelect: () => void;
}

const PaymentOption: React.FC<PaymentOptionProps> = ({
    icon: Icon,
    title,
    description,
    variant,
    onSelect,
}) => (
    <button
        type="button"
        onClick={onSelect}
        className={`enrollment-payment-option enrollment-payment-option--${variant}`}
        aria-label={`${title}. ${description}`}
    >
        <span className="enrollment-payment-option__icon" aria-hidden="true">
            <Icon size={25} strokeWidth={1.8} />
        </span>
        <span>
            <span className="enrollment-payment-option__title">{title}</span>
            <span className="enrollment-payment-option__description">{description}</span>
        </span>
        <ChevronRight className="enrollment-payment-option__arrow" size={20} aria-hidden="true" />
    </button>
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
        kind: PendingEnrollmentPaymentKind;
        billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
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

        const end = addCalendarMonthsClamped(start, duration);

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
                        const pendingKind = getPendingEnrollmentPaymentKind(
                            Number(payload.enrollmentFee || 0),
                            Number(payload.planDuration),
                        );
                        if (pendingKind === 'ENROLLMENT_FEE') {
                            const resumedPix = await asaasService.createEnrollmentPix();
                            setEnrollmentPix({
                                code: String(resumedPix.pixCode || ''),
                                qrCode: String(resumedPix.qrCode || ''),
                                paymentId: String(resumedPix.paymentId || ''),
                                kind: 'ENROLLMENT_FEE',
                                billingType: 'PIX',
                                amount: Number(payload.enrollmentFee),
                            });
                        } else if (pendingKind === 'ONE_TIME') {
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
                        } else {
                            // A assinatura e a primeira cobrança já existem. A
                            // retomada consulta somente o estado local e nunca
                            // tenta criar outra assinatura/cobrança no provedor.
                            setEnrollmentPix({
                                code: '',
                                qrCode: '',
                                paymentId: String(saved.subscription_id || ''),
                                kind: 'RECURRING_FIRST_PAYMENT',
                                billingType: progress.billing_type || 'PIX',
                                amount: Number(payload.value || 0),
                            });
                        }
                        setProcessingStage('BILLING');
                        setError(null);
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
        if (!isValidBrazilianMobile(normalizedPhone)) {
            nextErrors.phone = contractData?.isDependent
                ? 'Informe o celular do aluno com DDD. As confirmações de aula irão para ele.'
                : 'Informe um celular válido com DDD.';
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
                if (['SCHEDULE_UNAVAILABLE', 'SCHEDULE_OCCUPIED', 'SCHEDULE_RESERVED', 'SCHEDULE_CHANGED'].includes(claimResult?.error)) {
                    throw new Error('Um horário da grade não está mais disponível. A escola precisa gerar um novo link antes de qualquer cobrança.');
                }
                if (['FIRST_BILLING_DATE_PASSED', 'BILLING_PERIOD_EXPIRED'].includes(claimResult?.error)) {
                    throw new Error('O primeiro vencimento desta oferta já passou. Solicite um novo link com datas atualizadas.');
                }
                if (claimResult?.error === 'FINANCIAL_SCOPE_CONFLICT') {
                    throw new Error('Esta conta já possui outro vínculo financeiro ativo. A escola precisa revisar a matrícula antes de criar uma nova cobrança.');
                }
                if (claimResult?.error === 'INVALID_STUDENT_PHONE') {
                    throw new Error('O WhatsApp do aluno informado pela escola é inválido. Solicite um novo link com o número correto.');
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
            const proRataTerms = normalizeEnrollmentProRataTerms(enrollmentData);
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
                proRata: proRataTerms.enabled,
                proRataValue: proRataTerms.value > 0 ? proRataTerms.value : undefined,
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
            } else if (response.enrollment_complete !== true) {
                setEnrollmentPix({
                    code: '',
                    qrCode: '',
                    paymentId: confirmedSubId,
                    kind: 'RECURRING_FIRST_PAYMENT',
                    billingType,
                    amount: Number(enrollmentData.value || 0),
                });
                setProcessingStage('BILLING');
                setError(null);
                setStep('ENROLLMENT_PAYMENT');
            } else {
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
                errorMessage.includes('booking_materialization_failed') ||
                errorMessage.includes('enrollment_schedule_changed') ||
                errorMessage.includes('teacher_slot_')
            ) {
                errorMessage = 'Um horário da grade deixou de estar disponível. Nenhuma nova cobrança foi criada; peça à escola um novo link.';
            }
            if (errorMessage.includes('enrollment_financial_scope_conflict')) {
                errorMessage = 'Esta conta já possui outro vínculo financeiro ativo. A escola precisa revisar a matrícula antes de criar uma nova cobrança.';
            }
            if (errorMessage.includes('pro_rata_creation_failed')) {
                errorMessage = 'A assinatura foi localizada, mas a cobrança proporcional ainda não foi concluída. Seus dados foram preservados; tente novamente para reparar somente essa etapa.';
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
            if (getEnrollmentConfirmationSource(enrollmentPix.kind) === 'ENROLLMENT_PROGRESS') {
                const offerId = contractData?._offerId;
                if (typeof offerId !== 'string') {
                    throw new Error('enrollment_offer_missing');
                }
                const { data: progress, error: progressError } = await supabase.rpc('get_enrollment_progress', {
                    p_offer_id: offerId,
                });
                if (progressError) throw progressError;

                const progressOutcome = classifyEnrollmentProgressOutcome(progress);
                if (progressOutcome === 'COMPLETE') {
                    const { data: { session } } = await supabase.auth.getSession();
                    setProcessingStage('FINALIZING');
                    if (session) await sendCompletionNotifications(session.user.id, contractData);
                    setProcessingStage('COMPLETE');
                    setError(null);
                    setStep('SUCCESS');
                    return;
                }
                if (progressOutcome === 'UNAVAILABLE') {
                    throw new Error('enrollment_progress_unavailable');
                }

                setProcessingStage('BILLING');
                setError(
                    progressOutcome === 'AWAITING_PAYMENT'
                        ? 'Sua conta e seu contrato já foram criados. A primeira mensalidade ainda aguarda confirmação; nenhuma nova cobrança foi criada nesta consulta.'
                        : 'Sua conta e seu contrato já foram criados, mas a matrícula ainda está sendo processada. Aguarde alguns instantes e consulte novamente.'
                );
                return;
            }

            const res = enrollmentPix.kind === 'ONE_TIME'
                ? await (async () => {
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) return { success: false };
                    return asaasService.checkOneTimePayment(session.user.id);
                })()
                : await asaasService.checkPaymentStatus(enrollmentPix.paymentId);
            const paymentOutcome = classifyEnrollmentPaymentOutcome(res);
            if (paymentOutcome === 'COMPLETE') {
                const { data: { session } } = await supabase.auth.getSession();
                setProcessingStage('FINALIZING');
                if (session) await sendCompletionNotifications(session.user.id, contractData);
                setProcessingStage('COMPLETE');
                setError(null);
                setStep('SUCCESS');
            } else if (paymentOutcome === 'SETTLED_AWAITING_COMPLETION') {
                setProcessingStage('BILLING');
                setError(
                    enrollmentPix.kind === 'ENROLLMENT_FEE'
                        ? 'A taxa de matrícula foi confirmada, mas outra cobrança prevista no contrato ainda precisa ser confirmada. A taxa não será cobrada novamente. Aguarde a atualização automática ou fale com a escola.'
                        : 'O pagamento foi confirmado, mas a matrícula ainda está sendo concluída pelo sistema. Aguarde alguns instantes e consulte novamente.'
                );
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
        <section className="enrollment-financial-summary" aria-labelledby="enrollment-financial-title">
            <div className="enrollment-financial-summary__header">
                <h3 id="enrollment-financial-title">
                    <ReceiptText size={15} aria-hidden="true" />
                    Resumo financeiro
                </h3>
                <span className="text-[10px] font-bold text-slate-500">Valores do contrato</span>
            </div>

            {quote.dueToday > 0 ? (
                <div className="enrollment-financial-summary__today">
                    <span>Valor solicitado na conclusão de hoje</span>
                    <strong>{formatBrl(quote.dueToday)}</strong>
                </div>
            ) : null}

            <div className="enrollment-financial-summary__rows">
                <span>
                    {contractData?.planDuration === 0
                        ? 'Pagamento único'
                        : `${quote.installmentCount} mensalidades`}
                </span>
                <strong>
                    {contractData?.planDuration === 0
                        ? formatBrl(quote.installmentValue)
                        : `${quote.installmentCount} × ${formatBrl(quote.installmentValue)}`}
                </strong>
                {quote.enrollmentFee > 0 ? (
                    <>
                        <span>Taxa de matrícula via Pix</span>
                        <strong>{formatBrl(quote.enrollmentFee)}</strong>
                    </>
                ) : null}
                {quote.proRataValue > 0 ? (
                    <>
                        <span>Valor proporcional inicial</span>
                        <strong>{formatBrl(quote.proRataValue)}</strong>
                    </>
                ) : null}
                {contractData?.planDuration !== 0 ? (
                    <>
                        <span>Primeiro vencimento</span>
                        <strong>{formatDateBr(quote.firstDueDate)}</strong>
                    </>
                ) : null}
                <span className="enrollment-financial-summary__total">Total do contrato</span>
                <strong>{formatBrl(quote.total)}</strong>
            </div>
        </section>
    );

    // ========== PAYMENT SELECTION STEP ==========
    if (step === 'PAYMENT_SELECTION') {
        if (!contractData && !error) {
            return (
                <div className="enrollment-loading" role="status" aria-live="polite">
                    <div className="enrollment-loading__card">
                        <Loader2 className="animate-spin" size={20} aria-hidden="true" />
                        Preparando sua matrícula com segurança…
                    </div>
                </div>
            );
        }

        if (!contractData && error) {
            return (
                <EnrollmentShell
                    currentStep={1}
                    storyTitle={<>Uma jornada tranquila, <em>desde o primeiro passo.</em></>}
                    storyDescription="Sua matrícula foi desenhada para ser clara, segura e fácil de acompanhar."
                    school={school}
                >
                    <div className="py-8 text-center">
                        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-rose-50 text-rose-600">
                            <AlertCircle size={30} aria-hidden="true" />
                        </div>
                        <p className="enrollment-panel__eyebrow">Não foi possível continuar</p>
                        <h2 className="enrollment-panel__title">Link indisponível</h2>
                        <p className="enrollment-panel__description mx-auto">{error}</p>
                    </div>
                </EnrollmentShell>
            );
        }

        return (
            <EnrollmentShell
                currentStep={1}
                storyTitle={<>Seu próximo capítulo <em>começa aqui.</em></>}
                storyDescription="Em poucos minutos, você confirma seu plano, seus dados e a assinatura — com clareza em cada etapa."
                contractData={contractData}
                quote={quote}
                school={school}
            >
                {error ? (
                    <div className="enrollment-alert" role="alert">
                        <AlertCircle className="shrink-0" size={19} aria-hidden="true" />
                        <p>{error}</p>
                    </div>
                ) : null}

                <p className="enrollment-panel__eyebrow">Etapa 1 de 4</p>
                <h2 className="enrollment-panel__title">Como você prefere pagar?</h2>
                <p className="enrollment-panel__description">
                    Escolha a forma de pagamento do seu plano. Você revisará todos os dados antes de assinar.
                </p>

                {renderFinancialSummary()}

                <div className="enrollment-payment-options" role="group" aria-label="Formas de pagamento disponíveis">
                    <PaymentOption
                        icon={QrCode}
                        title="Pix"
                        description="O código é disponibilizado após seus dados e a assinatura."
                        variant="pix"
                        onSelect={() => {
                            setBillingType('PIX');
                            setStep('FORM');
                        }}
                    />
                    <PaymentOption
                        icon={CreditCard}
                        title="Cartão"
                        description="Cadastro protegido e cobrança conforme as condições do contrato."
                        variant="card"
                        onSelect={() => {
                            setBillingType('CREDIT_CARD');
                            setStep('FORM');
                        }}
                    />
                    <PaymentOption
                        icon={Barcode}
                        title="Boleto"
                        description="O boleto é disponibilizado ao final da contratação."
                        variant="boleto"
                        onSelect={() => {
                            setBillingType('BOLETO');
                            setStep('FORM');
                        }}
                    />
                </div>

                <p className="enrollment-trust-note">
                    <ShieldCheck size={15} aria-hidden="true" />
                    Seus dados são usados somente para concluir a matrícula e o contrato.
                </p>
            </EnrollmentShell>
        );
    }

    // ========== ENROLLMENT STEP (Ficha de Matrícula) ==========
    // ========== ENROLLMENT PAYMENT STEP (PIX QR CODE) ==========
    if (step === 'ENROLLMENT_PAYMENT') {
        const isRecurringFirstPayment = enrollmentPix?.kind === 'RECURRING_FIRST_PAYMENT';
        const pendingAmount = Number(enrollmentPix?.amount || 0);
        const paymentPresentation = getPendingEnrollmentPaymentPresentation(
            enrollmentPix?.kind,
            pendingAmount,
        );

        return (
            <EnrollmentShell
                currentStep={4}
                storyTitle={<>Tudo certo por aqui. <em>Falta só a confirmação.</em></>}
                storyDescription="Seu cadastro e sua assinatura já estão protegidos. Agora acompanhamos a confirmação financeira sem refazer nenhuma etapa."
                contractData={contractData}
                quote={quote}
                school={school}
            >
                <div className="enrollment-payment-status">
                    <div className="enrollment-payment-status__icon">
                        {isRecurringFirstPayment
                            ? <CreditCard size={34} strokeWidth={1.8} aria-hidden="true" />
                            : <QrCode size={34} strokeWidth={1.8} aria-hidden="true" />}
                    </div>
                    <p className="enrollment-panel__eyebrow">Etapa 4 de 4</p>
                    <h2 className="enrollment-panel__title">{paymentPresentation.title}</h2>
                    <p className="enrollment-panel__description mx-auto">
                        {enrollmentPix?.kind === 'ONE_TIME'
                            ? 'Conclua o pagamento para confirmar sua aula.'
                            : isRecurringFirstPayment
                                ? 'A matrícula será confirmada assim que a primeira mensalidade for reconhecida.'
                                : enrollmentPix?.kind === 'ENROLLMENT_FEE'
                                    ? 'Conclua o pagamento da matrícula para garantir sua vaga.'
                                    : 'Aguarde enquanto o sistema confirma sua matrícula.'}
                    </p>
                </div>

                <div className="mt-6 space-y-5 text-center">
                    {error ? (
                        <div role="status" aria-live="polite" className="enrollment-status-box enrollment-status-box--warning flex gap-3 text-left">
                            <AlertCircle className="shrink-0" size={19} aria-hidden="true" />
                            <p>{error}</p>
                        </div>
                    ) : null}

                    {enrollmentPix && paymentPresentation.showAmount ? (
                        <div className="enrollment-amount-card">
                            <span>{paymentPresentation.amountLabel}</span>
                            <strong>{formatBrl(pendingAmount)}</strong>
                        </div>
                    ) : null}

                    {isRecurringFirstPayment ? (
                        <div className="enrollment-status-box">
                            <CheckCircle className="mx-auto mb-2" size={28} aria-hidden="true" />
                            <p className="font-bold">Conta e contrato já estão criados</p>
                            <p className="mt-1">
                                A primeira mensalidade continua pendente. A confirmação será atualizada sem refazer cadastro, assinatura ou cobrança.
                            </p>
                        </div>
                    ) : null}

                    {!isRecurringFirstPayment && enrollmentPix?.billingType === 'PIX' && enrollmentPix?.qrCode ? (
                        <div className="enrollment-qr-card">
                            <img
                                src={`data:image/png;base64,${enrollmentPix.qrCode}`}
                                alt="QR Code Pix gerado pelo Asaas"
                                className="mx-auto size-64 max-w-full"
                            />
                        </div>
                    ) : !isRecurringFirstPayment && enrollmentPix?.billingType === 'PIX' && !enrollmentPix?.invoiceUrl ? (
                        <div className="flex h-56 items-center justify-center" role="status" aria-label="Gerando pagamento">
                            <Loader2 className="animate-spin text-slate-300" size={44} aria-hidden="true" />
                        </div>
                    ) : null}

                    {!isRecurringFirstPayment && enrollmentPix?.billingType === 'CREDIT_CARD' ? (
                        <div className="enrollment-status-box">
                            <CreditCard className="mx-auto mb-2" size={28} aria-hidden="true" />
                            <p className="font-bold">Pagamento enviado para confirmação</p>
                            <p className="mt-1">A operadora pode levar alguns instantes para confirmar.</p>
                        </div>
                    ) : null}

                    {enrollmentPix?.billingType === 'PIX' && enrollmentPix?.code ? (
                        <div className="space-y-3 text-left">
                            <label htmlFor="enrollment-pix-code">Código Pix copia e cola</label>
                            <div className="enrollment-code-row">
                                <input
                                    id="enrollment-pix-code"
                                    readOnly
                                    value={enrollmentPix.code}
                                    className="min-w-0 overflow-hidden text-ellipsis px-4 font-mono"
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        navigator.clipboard.writeText(enrollmentPix.code);
                                        alert('Código copiado!');
                                    }}
                                    className="enrollment-primary-button !min-h-[52px] !rounded-[13px]"
                                    aria-label="Copiar código Pix"
                                >
                                    <FileText size={19} aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {enrollmentPix?.invoiceUrl ? (
                        <a
                            href={enrollmentPix.invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="enrollment-primary-button w-full"
                        >
                            {enrollmentPix.billingType === 'BOLETO' ? 'Abrir boleto' : 'Abrir página de pagamento'}
                            <ArrowRight size={17} aria-hidden="true" />
                        </a>
                    ) : null}

                    <div className="flex flex-col gap-3 border-t border-slate-200 pt-6">
                        <button
                            type="button"
                            onClick={handleCheckEnrollmentPayment}
                            disabled={checkingPayment || !enrollmentPix}
                            className="enrollment-primary-button w-full"
                        >
                            {checkingPayment
                                ? <Loader2 className="animate-spin" size={18} aria-hidden="true" />
                                : <CheckCircle size={18} aria-hidden="true" />}
                            Consultar confirmação
                        </button>
                        <p className="text-[11px] font-medium leading-relaxed text-slate-500">
                            {isRecurringFirstPayment
                                ? 'Esta consulta verifica apenas o progresso salvo e não cria uma nova cobrança.'
                                : 'A confirmação pode levar alguns instantes após o pagamento.'}
                        </p>
                        {correlationId ? (
                            <div className="enrollment-protocol">
                                <span>Protocolo da matrícula</span>
                                <strong>{correlationId.slice(0, 8).toUpperCase()}</strong>
                            </div>
                        ) : null}
                    </div>
                </div>
            </EnrollmentShell>
        );
    }

    if (step === 'ENROLLMENT') {
        return (
            <EnrollmentShell
                currentStep={3}
                storyTitle={<>Revise com calma. <em>Assine com confiança.</em></>}
                storyDescription="Confirme os dados abaixo. O contrato completo será aberto em seguida para leitura e assinatura digital."
                contractData={contractData}
                quote={quote}
                school={school}
            >
                <p className="enrollment-panel__eyebrow">Etapa 3 de 4</p>
                <h2 className="enrollment-panel__title">Revise antes de assinar</h2>
                <p className="enrollment-panel__description">
                    Esta é a sua ficha de matrícula. Se algo estiver diferente, volte e corrija antes de abrir o contrato.
                </p>

                {renderFinancialSummary()}

                <form onSubmit={handleEnrollmentSubmit} className="mt-6">
                    <div className="enrollment-review-grid" aria-label="Dados informados">
                        {contractData?.isDependent ? (
                            <div className="enrollment-review-card sm:col-span-2">
                                <p className="enrollment-review-card__label">Responsável contratante</p>
                                <p className="enrollment-review-card__value">{contratanteName}</p>
                            </div>
                        ) : null}
                        <div className="enrollment-review-card">
                            <p className="enrollment-review-card__label">{contractData?.isDependent ? 'Aluno' : 'Nome completo'}</p>
                            <p className="enrollment-review-card__value">{name}</p>
                        </div>
                        <div className="enrollment-review-card">
                            <p className="enrollment-review-card__label">CPF do contratante</p>
                            <p className="enrollment-review-card__value">{formatCpf(contratanteCpf)}</p>
                        </div>
                        <div className="enrollment-review-card">
                            <p className="enrollment-review-card__label">E-mail de acesso</p>
                            <p className="enrollment-review-card__value">{email}</p>
                        </div>
                        <div className="enrollment-review-card">
                            <p className="enrollment-review-card__label">WhatsApp</p>
                            <p className="enrollment-review-card__value">{phone}</p>
                        </div>
                        <div className="enrollment-review-card sm:col-span-2">
                            <p className="enrollment-review-card__label">Endereço do contratante</p>
                            <p className="enrollment-review-card__value">{contratanteAddress}</p>
                        </div>
                    </div>

                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                        <button
                            type="button"
                            onClick={() => setStep('FORM')}
                            className="enrollment-secondary-button px-6 sm:flex-1"
                        >
                            <ArrowLeft size={16} aria-hidden="true" /> Voltar e editar
                        </button>
                        <button type="submit" className="enrollment-primary-button px-6 sm:flex-[1.7]">
                            Ler e assinar o contrato <ArrowRight size={17} aria-hidden="true" />
                        </button>
                    </div>
                </form>
            </EnrollmentShell>
        );
    }

    if (step === 'SUCCESS') {
        return (
            <EnrollmentShell
                currentStep={4}
                isFinished
                storyTitle={<>Agora é oficial. <em>Bem-vindo à sua jornada.</em></>}
                storyDescription="Sua matrícula foi concluída e seu acesso já está pronto. O próximo passo acontece dentro do portal."
                contractData={contractData}
                quote={quote}
                school={school}
            >
                <div className="py-4 text-center">
                    <div className="enrollment-success-icon">
                        <CheckCircle size={36} strokeWidth={1.9} aria-hidden="true" />
                    </div>
                    <p className="enrollment-panel__eyebrow">Matrícula concluída</p>
                    <h2 className="enrollment-panel__title">Tudo certo, {name.split(' ')[0] || 'bem-vindo'}!</h2>
                    <p className="enrollment-panel__description mx-auto">
                        Seu acesso ao portal foi criado, o contrato foi registrado e o fluxo financeiro foi confirmado.
                    </p>

                    <div className="mx-auto mt-7 grid max-w-md gap-3 text-left">
                        {['Contrato assinado digitalmente', 'Acesso ao portal liberado', 'Matrícula confirmada pela escola'].map(item => (
                            <div key={item} className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-sm font-bold text-emerald-900">
                                <CheckCircle size={17} className="shrink-0 text-emerald-600" aria-hidden="true" />
                                {item}
                            </div>
                        ))}
                    </div>

                    {correlationId ? (
                        <div className="enrollment-protocol mx-auto mt-6 max-w-md">
                            <span>Protocolo da matrícula</span>
                            <strong>{correlationId.slice(0, 8).toUpperCase()}</strong>
                        </div>
                    ) : null}

                    <a href="/" className="enrollment-primary-button mx-auto mt-7 w-full max-w-md">
                        Acessar meu portal <ArrowRight size={17} aria-hidden="true" />
                    </a>

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
            </EnrollmentShell>
        );
    }

    if (!contractData && !error) {
        return (
            <div className="enrollment-loading" role="status" aria-live="polite">
                <div className="enrollment-loading__card">
                    <Loader2 className="animate-spin" size={20} aria-hidden="true" />
                    Preparando seus dados…
                </div>
            </div>
        );
    }

    return (
        <>
            <EnrollmentShell
                currentStep={step === 'CONTRACT' ? 3 : 2}
                storyTitle={<>Tudo pronto para criar <em>o seu acesso.</em></>}
                storyDescription="Seus dados serão usados para o contrato, a cobrança e o acesso ao portal. Você poderá revisar tudo antes de assinar."
                contractData={contractData}
                quote={quote}
                school={school}
            >
                {error ? (
                    <div className="enrollment-alert" role="alert">
                        <AlertCircle className="shrink-0" size={19} aria-hidden="true" />
                        <p>{error}</p>
                    </div>
                ) : null}

                <p className="enrollment-panel__eyebrow">Etapa 2 de 4</p>
                <h2 className="enrollment-panel__title">Conte um pouco sobre você</h2>
                <p className="enrollment-panel__description">
                    Preencha os dados abaixo para prepararmos seu acesso e o contrato de matrícula.
                </p>

                <form onSubmit={handleFormSubmit} className="enrollment-form" noValidate>
                        {renderFinancialSummary()}
                        {/* 1. Payment Method Overview */}
                        <div className="enrollment-form-section">
                            <div className="enrollment-form-section__heading">
                                <h3 className="enrollment-form-section__title">
                                    <span className="enrollment-form-section__icon"><CreditCard size={16} aria-hidden="true" /></span>
                                    Forma de pagamento
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => setStep('PAYMENT_SELECTION')}
                                    className="enrollment-change-button"
                                >
                                    Alterar
                                </button>
                            </div>

                            {billingType === 'PIX' ? (
                                <div className="enrollment-selected-payment">
                                    <span className="enrollment-selected-payment__icon"><QrCode size={21} aria-hidden="true" /></span>
                                    <div>
                                        <strong>Pagamento via Pix</strong>
                                        <p>O código será gerado depois da revisão e da assinatura.</p>
                                    </div>
                                </div>
                            ) : null}

                            {billingType === 'BOLETO' ? (
                                <div className="enrollment-selected-payment">
                                    <span className="enrollment-selected-payment__icon !bg-amber-50 !text-amber-700"><Barcode size={21} aria-hidden="true" /></span>
                                    <div>
                                        <strong>Pagamento via boleto</strong>
                                        <p>O boleto será disponibilizado ao final da contratação.</p>
                                    </div>
                                </div>
                            ) : null}

                            {billingType === 'CREDIT_CARD' ? (
                                <div className="space-y-4 animate-in fade-in duration-300">
                                    <div className="enrollment-selected-payment">
                                        <span className="enrollment-selected-payment__icon !bg-blue-50 !text-blue-700"><CreditCard size={21} aria-hidden="true" /></span>
                                        <div>
                                            <strong>Pagamento via cartão</strong>
                                            <p>Os dados são enviados diretamente para o processamento seguro.</p>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div>
                                            <input
                                                type="tel"
                                                inputMode="numeric"
                                                autoComplete="cc-number"
                                                aria-label="Número do cartão"
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
                                                aria-label="Nome impresso no cartão"
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
                                                    aria-label="Validade do cartão"
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
                                                    aria-label="Código de segurança do cartão"
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

                                    <div className="flex items-center justify-center gap-2 pt-1 text-slate-500">
                                        <ShieldCheck size={14} aria-hidden="true" />
                                        <p className="text-[10px] font-semibold">Pagamento processado via Asaas</p>
                                    </div>
                                </div>
                            ) : null}
                        </div>

                        {/* 2. Personal Data */}
                        <div className="enrollment-form-section space-y-4">
                            <div className="enrollment-form-section__heading !mb-1">
                                <h3 className="enrollment-form-section__title">
                                    <span className="enrollment-form-section__icon"><User size={16} aria-hidden="true" /></span>
                                    Dados pessoais
                                </h3>
                            </div>

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
                                    {contractData?.guardianName ? <> (<strong>{contractData.guardianName}</strong>)</> : ''}, usando o telefone e o endereço financeiro dele.
                                    As confirmações de aula seguem para o <strong>WhatsApp do aluno</strong> informado pela escola.
                                    Você só precisa confirmar <strong>o nome do aluno</strong> (acima) e os <strong>dados de acesso</strong> (abaixo).
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
                        <div className="enrollment-form-section space-y-4">
                            <div className="enrollment-form-section__heading !mb-1">
                                <h3 className="enrollment-form-section__title">
                                    <span className="enrollment-form-section__icon"><MapPin size={16} aria-hidden="true" /></span>
                                    Endereço
                                </h3>
                            </div>
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
                                <div className="sm:col-span-2">
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
                        <div className="enrollment-form-section space-y-4">
                            <div className="enrollment-form-section__heading !mb-1">
                                <h3 className="enrollment-form-section__title">
                                    <span className="enrollment-form-section__icon"><Lock size={16} aria-hidden="true" /></span>
                                    Acesso ao portal
                                </h3>
                            </div>
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
                                                className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-brand-muted hover:bg-brand-surface"
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
                            className="enrollment-primary-button mt-2 w-full"
                        >
                            {loading
                                ? <Loader2 className="animate-spin" size={19} aria-hidden="true" />
                                : <>Revisar meus dados <ArrowRight size={18} aria-hidden="true" /></>}
                        </button>

                        <p className="enrollment-trust-note !mt-0">
                            <ShieldCheck size={14} aria-hidden="true" />
                            Na próxima etapa, você revisa os dados e lê o contrato antes de assinar.
                        </p>
                    </form>
            </EnrollmentShell>

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
            <div aria-hidden="true" style={{ position: 'absolute', top: '-9999px', left: '-9999px' }}>
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
        </>
    );
};

export default PublicRegistration;
