import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { PROFILE_SAFE_COLS } from '../constants';
import { Download, FileText, Loader2, Printer, RefreshCw } from 'lucide-react';
import { ContractDocument, type SchoolInfo } from './ContractDocument';
import { getSchoolInfo } from '../lib/schoolInfo';

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
    onDownloadReady?: (fn: () => void) => void;
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

    // Ref aponta direto para a folha A4 branca (sem zoom wrapper)
    const pdfRef = useRef<HTMLDivElement>(null);

    useEffect(() => { fetchContractData(); }, [userId]);

    const fetchContractData = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('profiles')
                .select(PROFILE_SAFE_COLS)
                .eq('id', userId)
                .single();
            if (error) throw error;
            setProfile(data);
            setContractUrl(await resolveContractUrl(data?.contract_url));
            // Carrega os dados da escola (cabeçalho/rodapé do contrato)
            setSchool(await getSchoolInfo(data?.tenant_id));
        } catch (err) {
            console.error('Erro ao carregar contrato:', err);
        } finally {
            setLoading(false);
        }
    };

    // Download real (sem dialog de impressão)
    const handleDownloadPdf = async () => {
        if (!pdfRef.current) return;
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

    // Expõe a função de download para o pai assim que o perfil carrega
    useEffect(() => {
        if (profile && onDownloadReady) {
            onDownloadReady(handleDownloadPdf);
        }
    }, [profile]);

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64 text-brand-muted gap-2">
                <RefreshCw className="animate-spin" /> Carregando contrato...
            </div>
        );
    }

    if (!profile) return <div className="text-sm text-brand-muted p-4">Contrato não encontrado.</div>;

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

    const enrollmentDate = new Date(profile.created_at || new Date());
    const dueDay = profile.due_day || 1;
    let startDateObj = new Date(enrollmentDate.getFullYear(), enrollmentDate.getMonth(), dueDay);
    if (enrollmentDate.getDate() > dueDay) {
        startDateObj = new Date(enrollmentDate.getFullYear(), enrollmentDate.getMonth() + 1, dueDay);
    }
    const endDateObj = new Date(startDateObj.getFullYear(), startDateObj.getMonth() + duration, dueDay);
    const startDate = startDateObj.toLocaleDateString('pt-BR');
    const endDate = endDateObj.toLocaleDateString('pt-BR');
    const monthlyFee = Number(profile.monthly_fee || 0);
    const totalValue = (monthlyFee * duration).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    // Dependente: CONTRATANTE é o responsável financeiro (guardian); o aluno aparece como dependente.
    const isDependent = !!(profile.guardian_id || profile.guardian_cpf);
    const contractProps = {
        innerRef: pdfRef,
        studentName: (isDependent ? profile.guardian_name : profile.full_name) || 'Aluno Wise Wolf',
        studentCPF: (isDependent ? profile.guardian_cpf : profile.cpf) || '000.000.000-00',
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
        dueDay: profile.due_day || 10,
        classFrequency: profile.class_frequency ? parseInt(String(profile.class_frequency)) : classFrequency,
        acceptedAt: profile.accepted_at,
        userIp: profile.signature_ip,
        showPrintButton: false,
    };

    return (
        <div className="space-y-4">

            {/* ── MOBILE: só botão de download (sem preview) ── */}
            <div className="sm:hidden flex flex-col items-center justify-center py-8 gap-6 px-4">
                <div className="w-20 h-20 rounded-3xl bg-[#002366]/10 flex items-center justify-center">
                    <FileText size={36} className="text-[#002366]" />
                </div>
                <div className="text-center">
                    <p className="font-black text-brand-text text-base">Seu Contrato</p>
                    <p className="text-xs text-brand-muted mt-1">
                        {profile.full_name} · {planName}
                    </p>
                </div>
                <button
                    onClick={handleDownloadPdf}
                    disabled={downloading}
                    className="flex items-center gap-3 px-8 py-4 bg-[#002366] text-white rounded-2xl text-sm font-black uppercase tracking-widest hover:bg-blue-900 active:scale-95 transition-all shadow-xl disabled:opacity-50 w-full justify-center"
                >
                    {downloading
                        ? <><Loader2 size={18} className="animate-spin" /> Gerando PDF...</>
                        : <><Download size={18} /> Baixar PDF</>
                    }
                </button>
                <p className="text-[10px] text-brand-muted text-center">
                    O arquivo será salvo no seu dispositivo
                </p>
                {/* Elemento A4 fora da tela — necessário para o html2pdf capturar (display:none bloqueia html2canvas) */}
                <div style={{ position: 'fixed', left: '-9999px', top: 0, width: '210mm', zIndex: -1, pointerEvents: 'none' }} aria-hidden="true">
                    <ContractDocument {...contractProps} />
                </div>
            </div>

            {/* ── DESKTOP: header de ação + preview completo ── */}
            <div className="hidden sm:block space-y-4">
                {showDownloadButton && (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                            <FileText size={18} className="text-tenant-primary" />
                            <span className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</span>
                        </div>
                        <button
                            onClick={handleDownloadPdf}
                            disabled={downloading}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 hover:scale-105 transition-all shadow-lg disabled:opacity-50"
                        >
                            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                            {downloading ? 'Gerando...' : 'Baixar PDF'}
                        </button>
                    </div>
                )}
                <div className="flex flex-col items-center overflow-x-hidden">
                    <style>{`
                        .contract-preview-wrap { transform-origin: top center; }
                        @media (min-width: 640px) and (max-width: 1023px) { .contract-preview-wrap { zoom: 0.58; } }
                        @media (min-width: 1024px) { .contract-preview-wrap { zoom: 0.82; } }
                        @media (min-width: 1280px) { .contract-preview-wrap { zoom: 1; } }
                    `}</style>
                    <div className="contract-preview-wrap shadow-2xl">
                        <ContractDocument {...contractProps} />
                    </div>
                </div>
            </div>

        </div>
    );
};

export default ContractView;
