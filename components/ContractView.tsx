import React, { useEffect, useRef, useState } from 'react';
import { contractReferenceDate, formatContractPeriod } from '../lib/contractDates';
import { supabase } from '../lib/supabase';
import { PROFILE_SAFE_COLS } from '../constants';
import { AlertCircle, Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import { ContractDocument, getSchoolContractIdentity, type SchoolInfo } from './ContractDocument';
import { getSchoolInfo } from '../lib/schoolInfo';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';

// O bucket 'contracts' é PRIVADO (dados pessoais/LGPD). Registros antigos guardam a URL
// pública completa; registros novos guardam apenas o path dentro do bucket. Em ambos os
// casos a visualização precisa de uma signed URL gerada na hora.
const CONTRACTS_PUBLIC_MARKER = '/storage/v1/object/public/contracts/';
async function resolveContractUrl(raw: string | null): Promise<string | null> {
    if (!raw) return null;
    let path: string | null = null;
    if (raw.includes(CONTRACTS_PUBLIC_MARKER)) {
        path = decodeURIComponent(raw.split(CONTRACTS_PUBLIC_MARKER)[1].split('?')[0]);
    } else if (!raw.startsWith('http')) {
        path = raw;
    }
    if (!path) return raw; // link externo (fora do storage) — usa como está
    const { data, error } = await supabase.storage.from('contracts').createSignedUrl(path, 60 * 60);
    if (error || !data?.signedUrl) {
        console.error('Erro ao gerar signed URL do contrato:', error);
        return raw;
    }
    return data.signedUrl;
}

interface ContractViewProps {
    userId: string;
    classFrequency?: number | string;
    showDownloadButton?: boolean;
    /** Expõe a função de download para o componente pai (ex: modal sticky header) */
    onDownloadReady?: (fn: () => Promise<void>) => void;
}

const ContractView: React.FC<ContractViewProps> = ({
    userId,
    classFrequency = 2,
    showDownloadButton = true,
    onDownloadReady,
}) => {
    const [profile, setProfile] = useState<any>(null);
    const [contractUrl, setContractUrl] = useState<string | null>(null);
    const [school, setSchool] = useState<SchoolInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloading, setDownloading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const schoolIdentity = getSchoolContractIdentity(school);

    // Ref aponta direto para a folha A4 branca (sem zoom wrapper)
    const pdfRef = useRef<HTMLDivElement>(null);

    useEffect(() => { fetchContractData(); }, [userId]);

    const fetchContractData = async () => {
        try {
            setLoading(true);
            setLoadError(null);
            const [profileResult, privateProfile] = await Promise.all([
                supabase
                    .from('profiles')
                    .select(PROFILE_SAFE_COLS)
                    .eq('id', userId)
                    .single(),
                loadAuthorizedProfilePrivate(userId),
            ]);
            if (profileResult.error) throw profileResult.error;
            const data: any = { ...profileResult.data, ...privateProfile };
            setProfile(data);
            setContractUrl(await resolveContractUrl(data.contract_url as string | null));
            // Carrega os dados da escola (cabeçalho/rodapé do contrato)
            setSchool(await getSchoolInfo(data.tenant_id as string));
        } catch (err) {
            console.error('Erro ao carregar contrato:', err);
            setProfile(null);
            setLoadError('Não foi possível carregar o contrato.');
        } finally {
            setLoading(false);
        }
    };

    // Download real (sem dialog de impressão)
    const handleDownloadPdf = async () => {
        if (!pdfRef.current) return;
        if (!schoolIdentity.isReady) {
            alert(`Download bloqueado: configure ${schoolIdentity.missingFields.join(', ')} para esta escola.`);
            return;
        }
        setDownloading(true);
        try {
            // Import dinâmico para não bloquear o bundle
            const html2pdf = (await import('html2pdf.js')).default;
            await html2pdf()
                .set({
                    margin: 0,
                    filename: `Contrato_${profile?.full_name?.replace(/\s+/g, '_') || 'Aluno'}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                })
                .from(pdfRef.current)
                .save();
        } catch (err) {
            console.error('Erro ao gerar PDF:', err);
            alert('Erro ao gerar PDF. Tente novamente.');
        } finally {
            setDownloading(false);
        }
    };

    // Expõe a ação correta para o cabeçalho do modal. Contratos enviados já
    // são PDFs; contratos digitais precisam ser renderizados antes do download.
    useEffect(() => {
        if (profile && onDownloadReady) {
            onDownloadReady(async () => {
                if (contractUrl) {
                    window.open(contractUrl, '_blank', 'noopener,noreferrer');
                    return;
                }
                await handleDownloadPdf();
            });
        }
    }, [profile, contractUrl]);

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64 text-brand-muted gap-2">
                <RefreshCw className="animate-spin" /> Carregando contrato...
            </div>
        );
    }

    if (!profile) return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-center dark:border-red-900/40 dark:bg-red-950/20" role="alert">
            <AlertCircle className="mx-auto mb-2 text-red-500" />
            <p className="text-sm font-bold text-red-700 dark:text-red-200">{loadError || 'Contrato não encontrado.'}</p>
            <button type="button" onClick={fetchContractData} className="mt-3 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white">
                Tentar novamente
            </button>
        </div>
    );

    // — Contrato PDF enviado pelo admin —
    // Iframe de PDF não funciona em mobile (iOS/Android bloqueiam ou mostram branco).
    // Solução: botão de abrir em nova aba sempre visível + iframe apenas no desktop.
    if (contractUrl) {
        return (
            <div className="space-y-4">
                {/* Botões de ação — sempre visíveis */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                        <FileText size={18} className="text-tenant-primary" />
                        <span className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</span>
                    </div>
                    <div className="flex gap-2">
                        <a
                            href={contractUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-tenant-primary text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-transform"
                        >
                            <Download size={14} /> Abrir PDF
                        </a>
                    </div>
                </div>
                {/* Preview via iframe — apenas desktop (sm+); em mobile o PDF fica inacessível via iframe */}
                <div className="hidden sm:block">
                    <iframe
                        src={contractUrl}
                        className="w-full h-[70vh] rounded-2xl border border-brand-border"
                        title="Contrato do Aluno"
                    />
                </div>
                {/* Mobile: card descritivo com botão grande */}
                <div className="sm:hidden flex flex-col items-center gap-4 py-8 px-4 bg-brand-surface-2 rounded-2xl border border-brand-border">
                    <FileText size={48} className="text-tenant-primary" />
                    <div className="text-center">
                        <p className="font-black text-brand-text">Contrato Digital</p>
                        <p className="text-xs text-brand-muted mt-1">Toque no botão abaixo para abrir o PDF</p>
                    </div>
                    <a
                        href={contractUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-8 py-4 bg-tenant-primary text-white rounded-2xl font-black uppercase tracking-widest hover:scale-105 transition-transform w-full justify-center"
                    >
                        <Download size={18} /> Abrir Contrato
                    </a>
                </div>
            </div>
        );
    }

    // — Template digital gerado —
    let duration = 12;
    let planName = 'Plano Recorrente';
    if (profile.module?.includes('Semestral') || profile.fidelity_plan === 'SEMESTER') { duration = 6; planName = 'Plano Semestral'; }
    else if (profile.module?.includes('Anual') || profile.fidelity_plan === 'ANNUAL') { duration = 12; planName = 'Plano Anual'; }

    const enrollmentDate = contractReferenceDate(profile.created_at);
    const dueDay = profile.due_day || 1;
    const { startDate, endDate } = formatContractPeriod(enrollmentDate, dueDay, duration);
    const monthlyFee = Number(profile.monthly_fee || 0);
    const totalValue = (monthlyFee * duration).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    // Dependente: CONTRATANTE é o responsável financeiro (guardian); o aluno aparece como dependente.
    const isDependent = !!(profile.guardian_id || profile.guardian_cpf);
    const contractProps = {
        studentName: (isDependent ? profile.guardian_name : profile.full_name) || 'Aluno não informado',
        studentCPF: (isDependent ? profile.guardian_cpf : profile.cpf) || '',
        dependentName: isDependent ? (profile.full_name || undefined) : undefined,
        studentAddress: `${profile.address || ''}, ${profile.address_number || ''} - ${profile.postal_code || ''}`,
        studentEmail: (isDependent ? profile.guardian_email : profile.email) || profile.email,
        studentPhone: (isDependent ? profile.guardian_phone : profile.phone) || '',
        school: school || undefined,
        planName,
        planValue: monthlyFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
        totalValue,
        planDuration: duration,
        startDate,
        endDate,
        dueDay,
        classFrequency: profile.class_frequency ? parseInt(String(profile.class_frequency)) : classFrequency,
        acceptedAt: profile.accepted_at,
        userIp: profile.signature_ip,
    };

    return (
        <div className="space-y-4">
            {showDownloadButton && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                        <FileText size={18} className="shrink-0 text-tenant-primary" />
                        <div className="min-w-0">
                            <p className="text-sm font-black uppercase tracking-widest text-brand-text">Seu Contrato</p>
                            <p className="truncate text-xs text-brand-muted">{profile.full_name} · {planName}</p>
                        </div>
                    </div>
                <button
                    type="button"
                    onClick={handleDownloadPdf}
                    disabled={downloading || !schoolIdentity.isReady}
                    title={!schoolIdentity.isReady ? 'Complete a identidade jurídica e a assinatura desta escola.' : undefined}
                        className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[#002366] px-4 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all hover:bg-blue-900 disabled:opacity-50 sm:w-auto"
                >
                    {downloading
                            ? <><Loader2 size={14} className="animate-spin" /> Gerando...</>
                            : <><Download size={14} /> Baixar PDF</>
                    }
                </button>
                </div>
            )}

            <div className="w-full overflow-hidden rounded-2xl border border-brand-border bg-brand-surface-2 p-2 sm:p-4">
                <ContractDocument
                    {...contractProps}
                    displayMode="responsive"
                    showPrintButton={false}
                />
            </div>

            {/* A4 imutável e fora da tela, usado exclusivamente pelo html2pdf. */}
            <div
                aria-hidden="true"
                style={{ position: 'fixed', left: '-12000px', top: 0, width: '210mm', zIndex: -1, pointerEvents: 'none' }}
            >
                <ContractDocument
                    {...contractProps}
                    displayMode="a4"
                    showPrintButton={false}
                    innerRef={pdfRef}
                />
            </div>
        </div>
    );
};

export default ContractView;
