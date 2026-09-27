import React, { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import { ShieldCheck, Building2, Printer } from 'lucide-react';
import { SUPABASE_URL } from '../lib/supabase-config';
import { contractIncludesLessonRecording, resolveContractTermsVersion } from '../lib/contractTerms';

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

/** Informações jurídicas da escola contratada, sempre fornecidas pelo tenant. */
export interface SchoolInfo {
    name?: string;
    legalName?: string;
    cnpj?: string;
    address?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    directorName?: string;
    legalRepresentativeName?: string;
    legalRepresentativeSignaturePath?: string;
    directorSignatureUrl?: string;
    legalRepresentativeSignatureUrl?: string;
    signatureUrl?: string;
}

export interface SchoolContractIdentity {
    name: string;
    cnpj: string;
    address: string;
    email: string;
    phone: string;
    city: string;
    state: string;
    directorName: string;
    signatureUrl: string | null;
    isReady: boolean;
    missingFields: string[];
}

/** Informações do plano/serviço contratado. */
export interface PlanInfo {
    planName: string;           // Ex: "Plano Semestral"
    planValue: string;          // Mensalidade. Ex: "149,90"
    totalValue: string;         // Total do contrato. Ex: "1.678,80"
    planDuration: number;       // Em meses; 0 representa serviço avulso
    startDate: string;          // "01/02/2025"
    endDate: string;            // "01/08/2025"
    dueDay: number;             // Dia de vencimento
    classFrequency: number | string;   // Ex: 2 ou "2 vezes por semana"
    classDuration?: number;     // Minutos por aula (padrão: 30)
    cancellationFee?: number;   // % multa rescisória (padrão: 30)
    repositionLimit?: number;   // Reposições por mês (padrão: 4)
}

/** Props principais do componente. */
interface ContractDocumentProps {
    // ── Dados do aluno (CONTRATANTE) ──
    studentName: string;
    studentCPF: string;
    studentAddress: string;
    studentEmail: string;
    studentPhone: string;

    /**
     * Nome do aluno beneficiário quando o CONTRATANTE é outro titular (responsável
     * financeiro). Ex.: contrato/cobrança no nome do titular (studentName/studentCPF),
     * aula para o beneficiário (dependentName) — qualquer relação (cônjuge, familiar,
     * terceiro pagador). Quando presente, exibe a linha "Aluno(a) Beneficiário(a)".
     */
    dependentName?: string;

    // ── Plano ──
    planName: string;
    planValue: string;
    totalValue: string;
    planDuration: number;
    startDate: string;
    endDate: string;
    dueDay: number;
    classFrequency: number | string;
    enrollmentFee?: number;
    proRataValue?: number;
    classDuration?: number;
    cancellationFee?: number;
    repositionLimit?: number;

    // ── Assinatura/Autenticação ──
    acceptedAt?: string;
    userIp?: string;
    subscriptionId?: string;
    /**
     * Versão do texto que a pessoa assinou (gravada no aceite — ver
     * `lib/contractTerms.ts`). Ausente: contrato assinado mostra o texto de
     * antes (versão 1) e contrato ainda não assinado mostra a versão atual.
     * Quem acabou de assinar na tela passa a versão atual explicitamente.
     */
    termsVersion?: number;

    // ── Personalização da escola (multi-tenant) ──
    school?: SchoolInfo;

    // ── UI ──
    showPrintButton?: boolean;
    /** Ref externo para captura do PDF (html2pdf.js) — aponta para a folha A4 */
    innerRef?: React.RefObject<HTMLDivElement>;
    /** "responsive" is for reading on screen; "a4" preserves the PDF layout. */
    displayMode?: 'responsive' | 'a4';
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDERS — nunca herdam identidade, PII ou assinatura da plataforma
// ─────────────────────────────────────────────────────────────────────────────
const SCHOOL_PLACEHOLDERS = {
    name: '[ NOME JURÍDICO DA ESCOLA NÃO CONFIGURADO ]',
    cnpj: '[ CNPJ NÃO CONFIGURADO ]',
    address: '[ ENDEREÇO JURÍDICO NÃO CONFIGURADO ]',
    email: '[ E-MAIL INSTITUCIONAL NÃO CONFIGURADO ]',
    phone: '[ TELEFONE INSTITUCIONAL NÃO CONFIGURADO ]',
    city: '[ CIDADE NÃO CONFIGURADA ]',
    state: '[ UF ]',
    directorName: '[ RESPONSÁVEL LEGAL NÃO CONFIGURADO ]',
};

const readSchoolValue = (school: SchoolInfo | null | undefined, keys: (keyof SchoolInfo)[]) => {
    for (const key of keys) {
        const value = school?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
};

const normalizeTenantSignatureUrl = (value: string) => {
    if (!value) return null;
    try {
        const parsed = new URL(value);
        const isLocalDevelopment = parsed.protocol === 'http:'
            && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
        const trustedStorageOrigin = new URL(SUPABASE_URL).origin;
        const isSignedPrivateAsset = parsed.origin === trustedStorageOrigin
            && parsed.pathname.includes('/storage/v1/object/sign/tenant-legal-assets/')
            && /\/legal-representative-signature\/[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/i.test(parsed.pathname)
            && Boolean(parsed.searchParams.get('token'));
        return (parsed.protocol === 'https:' || isLocalDevelopment)
            && !parsed.username
            && !parsed.password
            && !parsed.hash
            && isSignedPrivateAsset
            ? parsed.toString()
            : null;
    } catch {
        return null;
    }
};

const isValidCnpj = (value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;

    const calculateDigit = (base: string, weights: number[]) => {
        const sum = base.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
        const remainder = sum % 11;
        return remainder < 2 ? 0 : 11 - remainder;
    };

    const firstDigit = calculateDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const secondDigit = calculateDigit(`${digits.slice(0, 12)}${firstDigit}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return digits.endsWith(`${firstDigit}${secondDigit}`);
};

export function getSchoolContractIdentity(school?: SchoolInfo | null): SchoolContractIdentity {
    const configured = {
        name: readSchoolValue(school, ['legalName', 'name']),
        cnpj: readSchoolValue(school, ['cnpj']),
        address: readSchoolValue(school, ['address']),
        email: readSchoolValue(school, ['email']),
        phone: readSchoolValue(school, ['phone']),
        city: readSchoolValue(school, ['city']),
        state: readSchoolValue(school, ['state']).toUpperCase(),
        directorName: readSchoolValue(school, ['legalRepresentativeName', 'directorName']),
    };
    const rawSignatureUrl = readSchoolValue(school, [
        'legalRepresentativeSignatureUrl',
        'directorSignatureUrl',
        'signatureUrl',
    ]);
    const signatureUrl = normalizeTenantSignatureUrl(rawSignatureUrl);
    const missingFields = [
        !configured.name && 'nome/razão social',
        !isValidCnpj(configured.cnpj) && 'CNPJ válido',
        !configured.address && 'endereço jurídico',
        !configured.email && 'e-mail institucional',
        !configured.phone && 'telefone institucional',
        !configured.city && 'cidade',
        !/^[A-Z]{2}$/.test(configured.state) && 'UF',
        !configured.directorName && 'responsável legal',
        !signatureUrl && 'assinatura privada válida do responsável legal',
    ].filter((field): field is string => Boolean(field));

    return {
        name: configured.name || SCHOOL_PLACEHOLDERS.name,
        cnpj: configured.cnpj || SCHOOL_PLACEHOLDERS.cnpj,
        address: configured.address || SCHOOL_PLACEHOLDERS.address,
        email: configured.email || SCHOOL_PLACEHOLDERS.email,
        phone: configured.phone || SCHOOL_PLACEHOLDERS.phone,
        city: configured.city || SCHOOL_PLACEHOLDERS.city,
        state: configured.state.length === 2 ? configured.state : SCHOOL_PLACEHOLDERS.state,
        directorName: configured.directorName || SCHOOL_PLACEHOLDERS.directorName,
        signatureUrl,
        isReady: missingFields.length === 0,
        missingFields,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLÁUSULA DO REGISTRO DAS AULAS (versão 2 em diante)
// ─────────────────────────────────────────────────────────────────────────────
// Resume o aviso completo do registro das aulas (termo v3 em
// private.lesson_recording_terms, público STUDENT) e remete a ele. O registro é
// decisão da escola (27/09/2026): quem assina este contrato já concorda.
// ⚠️ Texto de contrato assinado não muda: qualquer alteração aqui é versão
// nova em lib/contractTerms.ts (e na tabela contract_terms_versions).
const clauseTitle = 'font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1';
const clauseText = 'text-justify text-gray-700 leading-relaxed';

function StudentLessonRecordingClause() {
    return (
        <div data-contract-clause="registro-das-aulas">
            <h3 className={clauseTitle}>
                Cláusula 8 — Do Registro das Aulas
            </h3>
            <p className={clauseText}>
                As aulas online acontecem em salas do Google Meet criadas pela <strong>CONTRATADA</strong> e, por decisão dela, são registradas, <strong>sem gravação em vídeo</strong>, da seguinte forma: <strong>(a)</strong> transcrição automática do que foi falado e anotações automáticas geradas pelo Google; <strong>(b)</strong> relatório com os horários de entrada e saída de cada participante na sala.
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 1º.</strong> O registro é usado exclusivamente para: <strong>(a)</strong> dar continuidade pedagógica às aulas; <strong>(b)</strong> preparar, com auxílio de inteligência artificial, o resumo de cada aula, que só passa a integrar a ficha do aluno depois de lido, corrigido quando necessário e aprovado pelo professor; <strong>(c)</strong> planejar as próximas aulas e as tarefas, com auxílio de inteligência artificial e revisão do professor, a partir do resumo aprovado; <strong>(d)</strong> entregar o histórico pedagógico do aluno ao professor que o assumir ou substituir, por link que só abre com login na plataforma da CONTRATADA; <strong>(e)</strong> confirmar que a aula aconteceu, pelos horários de entrada e saída.
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 2º.</strong> Além da CONTRATADA, tratam esses dados, em nome dela: o Google (Google Workspace), que fornece a sala, a transcrição, as anotações e o relatório de presença; o fornecedor da plataforma de ensino usada pela CONTRATADA, que armazena os dados e presta suporte técnico, podendo ver o resumo aprovado e o cartão pedagógico do aluno somente para resolver problema técnico; e o provedor de inteligência artificial contratado pela CONTRATADA (OpenRouter), em serviço pago, com o uso dos dados para treinar modelos desligado. A transcrição completa só é acessível ao professor da aula, à coordenação e à direção da CONTRATADA.
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 3º.</strong> A transcrição, as anotações e o relatório de presença, inclusive os trechos copiados para o resumo, são eliminados em até <strong>90 (noventa) dias</strong> após a aula, na plataforma e na conta Google da CONTRATADA (os arquivos originais passam pela lixeira do Google, que os elimina em até 30 dias). O resumo aprovado e o cartão pedagógico do aluno (objetivo, temas de interesse e forma preferida de correção, anotados pelo professor, nunca com informação sobre saúde, religião, política, família ou dinheiro; para menores de 18 anos, somente objetivo e temas) são mantidos enquanto o aluno estudar na CONTRATADA e eliminados <strong>90 (noventa) dias</strong> após a sua saída.
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 4º.</strong> O CONTRATANTE pode, a qualquer tempo: <strong>(a)</strong> ver no aplicativo da CONTRATADA os resumos aprovados das aulas; <strong>(b)</strong> pedir, pelo WhatsApp da CONTRATADA, que as aulas deixem de ser registradas, caso em que elas continuam normalmente, sem registro; <strong>(c)</strong> pedir, pelo mesmo canal, a exclusão do que já foi registrado; <strong>(d)</strong> pedir informação, correção ou cópia dos seus dados, nos termos da Lei nº 13.709/2018 (LGPD).
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 5º.</strong> Quando o aluno for menor de 18 (dezoito) anos, este contrato é assinado pelo seu responsável legal, que concorda, em nome do aluno, com o registro previsto nesta cláusula.
            </p>
            <p className={`${clauseText} mt-1`}>
                <strong>Parágrafo 6º.</strong> O aviso completo sobre o registro das aulas, com o detalhamento de quem vê cada informação e dos prazos, fica disponível no aplicativo da CONTRATADA, na área das aulas registradas.
            </p>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
export function ContractDocument({
    studentName,
    studentCPF,
    studentAddress,
    studentEmail,
    studentPhone,
    dependentName,
    planName,
    planValue,
    totalValue,
    planDuration,
    startDate,
    endDate,
    dueDay,
    classFrequency,
    enrollmentFee = 0,
    proRataValue = 0,
    classDuration = 30,
    cancellationFee = 30,
    repositionLimit = 4,
    acceptedAt,
    userIp,
    subscriptionId,
    termsVersion,
    school,
    showPrintButton = true,
    innerRef,
    displayMode = 'a4',
}: ContractDocumentProps) {
    const componentRef = useRef<HTMLDivElement>(null);
    // Usa innerRef externo se fornecido, senão usa o interno
    const a4Ref = (innerRef || componentRef) as React.RefObject<HTMLDivElement>;

    const s = getSchoolContractIdentity(school);
    const isOneTime = planDuration === 0;
    // Contrato assinado nunca muda de texto: sem versão gravada no aceite, é o
    // texto de antes da cláusula do registro das aulas.
    const contractVersion = resolveContractTermsVersion('STUDENT', {
        signed: Boolean(acceptedAt),
        recordedVersion: termsVersion,
    });
    const withLessonRecording = contractIncludesLessonRecording('STUDENT', contractVersion);

    const handlePrint = useReactToPrint({
        contentRef: a4Ref,
        documentTitle: `Contrato_${s.name.replace(/\s+/g, '_')}_${studentName.replace(/\s+/g, '_')}`,
    });

    // Data do contrato: quando já assinado, congela na data da assinatura (acceptedAt) —
    // antes usava sempre new Date(), então a data "atualizava" toda vez que o aluno reabria.
    const today = (acceptedAt ? new Date(acceptedAt) : new Date()).toLocaleDateString('pt-BR', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    const isResponsive = displayMode === 'responsive';
    const handleSafePrint = () => {
        if (!s.isReady) return;
        handlePrint();
    };

    return (
        <div className={`contract-doc-outer flex w-full flex-col items-center gap-4 ${isResponsive ? 'bg-transparent p-0' : 'bg-gray-100 p-4'}`}>

            {/* Barra de ações — oculta na impressão */}
            {showPrintButton && (
                <div className="w-full max-w-[210mm] flex items-center justify-between gap-3 flex-wrap contract-no-print">
                    {!s.isReady && (
                        <div role="alert" className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex-1 min-w-0">
                            <Building2 size={12} className="shrink-0" />
                            <span>Rascunho sem validade para assinatura: configure {s.missingFields.join(', ')} nas configurações da escola.</span>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={handleSafePrint}
                        disabled={!s.isReady}
                        title={!s.isReady ? 'Complete a identidade jurídica e a assinatura da escola antes de imprimir.' : undefined}
                        className="flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-lg text-sm font-bold hover:bg-blue-900 transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <Printer size={14} /> Imprimir
                    </button>
                </div>
            )}

            {/* ─── Folha A4 ─── */}
            <div
                ref={a4Ref}
                className={isResponsive
                    ? 'contract-doc-responsive w-full max-w-[210mm] overflow-hidden rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-gray-800 shadow-sm sm:p-8 lg:p-[18mm] lg:text-[11px]'
                    : 'w-[210mm] min-h-[297mm] bg-white p-[22mm] shadow-2xl text-gray-800 text-[11px] leading-relaxed'}
                style={{ fontFamily: 'Arial, sans-serif' }}
            >
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap');
                    @media print {
                        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: white !important; }
                        .contract-doc-outer { background: none !important; padding: 0 !important; min-height: 0 !important; }
                        .contract-no-print { display: none !important; }
                        @page { size: A4; margin: 0mm; }
                    }
                    @media (max-width: 639px) {
                        .contract-doc-responsive p {
                            font-size: 0.8125rem !important;
                            line-height: 1.5 !important;
                            overflow-wrap: anywhere;
                        }
                        .contract-doc-responsive h2 {
                            font-size: 1rem !important;
                            line-height: 1.35 !important;
                        }
                        .contract-doc-responsive h3 {
                            font-size: 0.75rem !important;
                            line-height: 1.4 !important;
                        }
                        .contract-doc-responsive .contract-document-header {
                            flex-direction: column;
                            gap: 0.75rem;
                        }
                        .contract-doc-responsive .contract-document-header > :last-child {
                            text-align: left;
                        }
                        .contract-doc-responsive .contract-summary-grid {
                            grid-template-columns: repeat(2, minmax(0, 1fr));
                            gap: 0.75rem;
                        }
                        .contract-doc-responsive .contract-signatures {
                            flex-direction: column;
                            gap: 2.5rem;
                        }
                        .contract-doc-responsive .contract-authentication {
                            align-items: flex-start;
                        }
                        .contract-doc-responsive .contract-authentication > :last-child {
                            min-width: 0;
                        }
                    }
                `}</style>

                {!s.isReady && (
                    <div className="mb-5 border-2 border-amber-400 bg-amber-50 p-3 text-center text-[10px] font-bold uppercase tracking-wide text-amber-900">
                        Rascunho bloqueado — identidade jurídica ou assinatura da escola incompleta
                    </div>
                )}

                {/* ── CABEÇALHO ── */}
                <div className="contract-document-header flex justify-between items-start mb-6 pb-4 border-b-2 border-[#002366]">
                    <div>
                        <div className="text-xl font-black text-[#002366] tracking-tighter leading-tight">
                            {s.name.split(' ').map((word, i) =>
                                i === s.name.split(' ').length - 1
                                    ? <span key={i} className="text-red-600">{word}</span>
                                    : <span key={i}>{word} </span>
                            )}
                        </div>
                        <div className="text-[9px] text-gray-400 mt-1 uppercase tracking-wider">
                            CNPJ: {s.cnpj}
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-[10px] text-gray-600 font-bold uppercase tracking-wide">
                            Contrato de Prestação de
                        </div>
                        <div className="text-[10px] text-gray-600 uppercase tracking-wide">
                            Serviços Educacionais
                        </div>
                        <div className="text-[9px] text-gray-400 mt-1">
                            {s.city} - {s.state}
                        </div>
                    </div>
                </div>

                {/* ── TÍTULO ── */}
                <h2 className="text-center text-sm font-black uppercase text-[#002366] tracking-wider mb-6">
                    Contrato de Prestação de Serviços Educacionais
                </h2>

                {/* ── QUALIFICAÇÃO DAS PARTES ── */}
                <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-md">
                    <p className="font-bold text-[#002366] text-[10px] uppercase tracking-wider mb-2">I. Das Partes</p>
                    <p className="mb-1">
                        <strong>CONTRATANTE:</strong> {studentName.toUpperCase()}, CPF nº {studentCPF || '__________._____.__-__'}
                    </p>
                    {dependentName && (
                        <p className="mb-1">
                            <strong>ALUNO(A) BENEFICIÁRIO(A):</strong> {dependentName.toUpperCase()} (beneficiário(a) dos serviços educacionais, cuja contratação e pagamento são realizados pelo CONTRATANTE)
                        </p>
                    )}
                    <p className="mb-1">
                        Residente em: {studentAddress || '______________________________________________________'}
                    </p>
                    <p className="mb-3">
                        E-mail: {studentEmail || '__________________________'} | Tel: {studentPhone || '______________'}
                    </p>

                    <p className="mb-1">
                        <strong>CONTRATADA:</strong> {s.name}, inscrita no CNPJ sob nº {s.cnpj}
                    </p>
                    <p className="mb-1">
                        Endereço: {s.address}
                    </p>
                    <p>
                        E-mail: {s.email} | Tel: {s.phone}
                    </p>
                </div>

                {/* ── RESUMO DO PLANO ── */}
                <div className="mb-4 p-3 bg-[#002366]/5 border border-[#002366]/20 rounded-md">
                    <p className="font-bold text-[#002366] text-[10px] uppercase tracking-wider mb-2">II. Resumo do Plano Contratado</p>
                    <div className="contract-summary-grid grid grid-cols-3 gap-2 text-[10px]">
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">Plano</p>
                            <p className="font-bold">{planName}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">{isOneTime ? 'Valor' : 'Mensalidade'}</p>
                            <p className="font-bold">R$ {planValue}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">Total</p>
                            <p className="font-bold">R$ {totalValue}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">Duração</p>
                            <p className="font-bold">{isOneTime ? 'Serviço avulso' : `${planDuration} ${planDuration === 1 ? 'mês' : 'meses'}`}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">Frequência</p>
                            <p className="font-bold">{classFrequency}x/semana ({classDuration} min)</p>
                        </div>
                        <div>
                            <p className="text-gray-500 text-[9px] uppercase">Vencimento</p>
                            <p className="font-bold">{isOneTime ? `Pagamento único (dia ${dueDay})` : `Dia ${dueDay} de cada mês`}</p>
                        </div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-[#002366]/20 text-[9px] text-gray-500">
                        <strong>Vigência:</strong> {startDate} a {endDate}
                        {enrollmentFee > 0 && (
                            <> | <strong>Taxa de matrícula:</strong> R$ {enrollmentFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</>
                        )}
                        {proRataValue > 0 && (
                            <> | <strong>Valor proporcional inicial:</strong> R$ {proRataValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</>
                        )}
                    </div>
                </div>

                {/* ── CLÁUSULAS ── */}
                <div className="space-y-3 text-[10px]">

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 1 — Do Objeto
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            {isOneTime ? (
                                <>O presente contrato tem por objeto uma prestação avulsa de serviço educacional de língua inglesa pela <strong>CONTRATADA</strong> ao <strong>CONTRATANTE</strong>, consistindo em uma aula online individual de <strong>{classDuration} (trinta) minutos</strong>, no horário contratado.</>
                            ) : (
                                <>O presente contrato tem por objeto a prestação de serviços educacionais de ensino de língua inglesa pela <strong>CONTRATADA</strong> ao <strong>CONTRATANTE</strong>, consistindo em aulas online individuais de <strong>{classDuration} (trinta) minutos</strong>, realizadas <strong>{classFrequency} (
                                {typeof classFrequency === 'number'
                                    ? ['uma', 'duas', 'três', 'quatro', 'cinco'][classFrequency - 1] || classFrequency
                                    : classFrequency}
                                ) vezes por semana</strong>, além de acesso à plataforma de aprendizagem com materiais didáticos, atividades complementares e suporte de inteligência artificial (Wolfie AI Tutor).</>
                            )}
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 2 — Da Vigência
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            {isOneTime ? (
                                <>O presente contrato refere-se a uma prestação avulsa, com execução no período de <strong>{startDate}</strong> a <strong>{endDate}</strong>, e <strong>não possui renovação automática</strong>.</>
                            ) : (
                                <>O presente contrato terá vigência de <strong>{planDuration} ({
                                    ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze'][planDuration - 1] || planDuration
                                }) {planDuration === 1 ? 'mês' : 'meses'}</strong>, com início em <strong>{startDate}</strong> e término em <strong>{endDate}</strong>. Ao término do período, o contrato será renovado automaticamente por prazo indeterminado, salvo manifestação em contrário de qualquer das partes com antecedência mínima de <strong>15 (quinze) dias</strong>.</>
                            )}
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 3 — Do Valor e Forma de Pagamento
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            {isOneTime ? (
                                <>O valor total do serviço avulso é de <strong>R$ {totalValue} (reais)</strong>, pago em parcela única por boleto bancário, PIX ou cartão de crédito, conforme opção do CONTRATANTE. A confirmação da aula fica condicionada à identificação do pagamento.</>
                            ) : (
                                <>O valor total do presente contrato é de <strong>R$ {totalValue} (reais)</strong>, incluindo as cobranças iniciais discriminadas no resumo quando aplicáveis. As mensalidades serão pagas em <strong>{planDuration} ({
                                    ['uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze'][planDuration - 1] || planDuration
                                }) parcelas mensais no valor unitário de R$ {planValue}</strong>, referente ao <strong>{planName}</strong>. O vencimento das parcelas será no dia <strong>{dueDay}</strong> de cada mês, mediante boleto bancário, PIX ou cartão de crédito, conforme opção do CONTRATANTE. O não pagamento até o 7º (sétimo) dia útil após o vencimento autoriza a CONTRATADA a suspender o acesso à plataforma e às aulas até a regularização.</>
                            )}
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 4 — Das Obrigações do Contratante
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            O CONTRATANTE se compromete a: <strong>(a)</strong> dispor de equipamento (computador, tablet ou smartphone) com microfone, câmera e conexão de internet compatíveis com videoconferência; <strong>(b)</strong> efetuar os pagamentos nas datas acordadas; <strong>(c)</strong> comunicar ausências com antecedência mínima de <strong>24 (vinte e quatro) horas</strong>, sendo assegurada a reposição de até <strong>{repositionLimit} ({['uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'][repositionLimit - 1] || repositionLimit}) {repositionLimit === 1 ? 'aula' : 'aulas'} por mês</strong> mediante disponibilidade da agenda; <strong>(d)</strong> respeitar os direitos de propriedade intelectual dos materiais fornecidos; <strong>(e)</strong> auditar e confirmar, a cada aula, se ela efetivamente ocorreu, por meio do link de confirmação/auditoria enviado pela CONTRATADA — sendo esta a forma oficial de comprovação da aula realizada. É obrigação do CONTRATANTE realizar essa auditoria; na ausência de confirmação pelo CONTRATANTE, a aula será considerada realizada mediante registro de presença pelo professor (veredito do professor), para todos os fins, inclusive de apuração e cobrança.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 5 — Das Obrigações e Direitos da Contratada
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            A CONTRATADA se compromete a: <strong>(a)</strong> fornecer aulas com professores qualificados, podendo designar substitutos em caso de impedimento do professor titular; <strong>(b)</strong> manter a plataforma disponível com disponibilidade mínima de 95% ao mês; <strong>(c)</strong> proteger os dados pessoais do CONTRATANTE nos termos da Lei nº 13.709/2018 (LGPD); <strong>(d)</strong> enviar ao CONTRATANTE, a cada aula, o registro de realização (link de confirmação/auditoria), de modo que o CONTRATANTE possa auditar se a aula efetivamente ocorreu. A CONTRATADA poderá <strong>reajustar os valores</strong> anualmente pelo índice IPCA ou IGPM, mediante comunicação prévia de 30 dias.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 6 — Da Rescisão e Multa Contratual
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            {isOneTime ? (
                                <>Por se tratar de serviço avulso, não há fidelidade nem renovação. Pedidos de cancelamento ou reagendamento devem ser comunicados com antecedência mínima de <strong>24 (vinte e quatro) horas</strong>, sujeitos à disponibilidade da agenda.</>
                            ) : (
                                <>O presente contrato poderá ser rescindido por qualquer das partes mediante comunicação prévia de <strong>15 (quinze) dias</strong>. Em caso de rescisão antecipada por iniciativa do CONTRATANTE sem justa causa, será cobrada multa compensatória equivalente a <strong>{cancellationFee}% (
                                    {['dez', 'quinze', 'vinte', 'trinta', 'quarenta', 'cinquenta'][
                                        [10, 15, 20, 30, 40, 50].indexOf(cancellationFee)
                                    ] || cancellationFee} por cento
                                ) do valor restante do contrato</strong>, a fim de compensar custos administrativos e operacionais.</>
                            )}
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            Cláusula 7 — Da Proteção de Dados (LGPD)
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            O CONTRATANTE autoriza o tratamento de seus dados pessoais pela CONTRATADA exclusivamente para os fins de execução deste contrato, melhoria dos serviços educacionais e comunicações relacionadas, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018). Os dados não serão compartilhados com terceiros sem consentimento expresso.
                        </p>
                    </div>

                    {withLessonRecording && <StudentLessonRecordingClause />}

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] text-[9px] tracking-wider mb-1">
                            {/* Na versão com o registro das aulas o Foro passa a ser a 9;
                                nenhuma cláusula do aluno cita outra pelo número. */}
                            {withLessonRecording ? 'Cláusula 9 — Do Foro' : 'Cláusula 8 — Do Foro'}
                        </h3>
                        <p className="text-justify text-gray-700 leading-relaxed">
                            As partes elegem o foro da Comarca de <strong>{s.city} — {s.state}</strong> para dirimir quaisquer controvérsias oriundas deste instrumento, com renúncia expressa a qualquer outro, por mais privilegiado que seja.
                        </p>
                    </div>

                </div>

                {/* ── DECLARAÇÃO FINAL ── */}
                <p className="mt-4 text-[10px] text-gray-600 text-justify border-t border-gray-200 pt-3">
                    Por estarem justas e contratadas, as partes assinam o presente instrumento em 2 (duas) vias de igual teor e forma.
                </p>

                {/* ── ASSINATURAS ── */}
                <div className="mt-8 pt-4 border-t border-gray-300">
                    <p className="text-center text-[10px] mb-8 text-gray-600">
                        {s.city} — {s.state}, {today}
                    </p>

                    <div className="contract-signatures flex justify-between gap-12 mt-8 min-h-[110px]">

                        {/* Assinatura da escola — sempre específica do tenant */}
                        <div className="flex-1 flex flex-col items-center justify-end">
                            <div className="mb-2 h-16 flex items-end justify-center w-full">
                                {s.signatureUrl ? (
                                    <img
                                        src={s.signatureUrl}
                                        alt={`Assinatura de ${s.directorName}`}
                                        className="h-14 object-contain opacity-90"
                                        crossOrigin="anonymous"
                                    />
                                ) : (
                                    <span className="text-center text-[9px] font-bold text-amber-700">
                                        Assinatura da contratada não configurada
                                    </span>
                                )}
                            </div>
                            <div className="border-t border-gray-800 pt-2 w-full text-center">
                                <p className="font-bold text-[#002366] text-[10px] uppercase">{s.directorName}</p>
                                <p className="text-[9px] text-gray-600">Representante legal de {s.name}</p>
                                <p className="text-[9px] text-gray-500">CNPJ: {s.cnpj}</p>
                                {s.signatureUrl && (
                                    <div className="flex items-center justify-center gap-1 text-[8px] text-emerald-700 font-bold mt-1 bg-emerald-50 py-0.5 rounded-full w-fit mx-auto px-2 border border-emerald-200">
                                        <ShieldCheck size={8} /> Assinatura cadastrada pelo tenant
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Assinatura do aluno */}
                        <div className="flex-1 flex flex-col items-center justify-end">
                            <div className="mb-2 text-center h-16 flex items-end justify-center relative w-full">
                                {acceptedAt ? (
                                    <>
                                        <span
                                            className="text-2xl text-gray-800 transform -rotate-1 relative z-10"
                                            style={{ fontFamily: '"Dancing Script", cursive' }}
                                        >
                                            {studentName}
                                        </span>
                                        <div className="absolute -right-2 top-0 border border-emerald-200 bg-emerald-50/90 p-1.5 rounded text-[7px] text-emerald-800 leading-tight w-20 opacity-80 rotate-3">
                                            <p className="font-bold">ASSINADO</p>
                                            <p>Eletronicamente</p>
                                            {userIp && <p className="truncate">IP: {userIp}</p>}
                                            {subscriptionId && <p className="truncate">ID: {subscriptionId.substring(0, 8)}</p>}
                                        </div>
                                    </>
                                ) : (
                                    <span className="text-gray-300 italic text-xs">Aguardando assinatura...</span>
                                )}
                            </div>
                            <div className="border-t border-gray-800 pt-2 w-full text-center">
                                <p className="font-bold uppercase text-[10px]">{studentName}</p>
                                <p className="text-[9px] text-gray-500 uppercase">Contratante — CPF: {studentCPF || '___.___.___-__'}</p>
                            </div>
                        </div>

                    </div>
                </div>

                {/* ── SELO DE AUTENTICAÇÃO DIGITAL ── */}
                {acceptedAt && (
                    <div className="mt-8 p-4 bg-gray-50 border border-gray-200 rounded-xl relative overflow-hidden">
                        <div className="contract-authentication flex items-center gap-4 relative z-10">
                            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-full flex-shrink-0">
                                <ShieldCheck size={36} />
                            </div>
                            <div className="flex-1">
                                <h4 className="text-[11px] font-black text-[#002366] uppercase tracking-wider mb-1">
                                    Documento Autenticado Digitalmente
                                </h4>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[9px] text-gray-600 font-mono">
                                    <p><strong>Assinado em:</strong> {new Date(acceptedAt).toLocaleString('pt-BR')}</p>
                                    <p><strong>IP de Registro:</strong> {userIp || 'Não registrado'}</p>
                                    <p><strong>Protocolo:</strong> {subscriptionId || 'PENDING'}</p>
                                    <p><strong>Plataforma:</strong> {s.name}</p>
                                    {/* Só a partir da versão 2: o selo dos contratos de antes fica como era. */}
                                    {contractVersion > 1 && <p><strong>Versão do texto:</strong> {contractVersion}</p>}
                                </div>
                                <p className="text-[8px] text-gray-400 mt-1.5 italic">
                                    Este documento possui validade jurídica conforme MP 2.200-2/2001 e Lei 14.063/2020.
                                </p>
                            </div>
                        </div>
                        <div className="absolute -right-8 -bottom-8 text-gray-100 rotate-[-15deg] pointer-events-none">
                            <ShieldCheck size={140} />
                        </div>
                    </div>
                )}

            </div>
            {/* fim folha A4 */}

        </div>
    );
}
