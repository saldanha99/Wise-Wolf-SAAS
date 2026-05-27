import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Download, FileText, Loader2, Printer, RefreshCw } from 'lucide-react';
import { ContractDocument } from './ContractDocument';

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
                .select('*')
                .eq('id', userId)
                .single();
            if (error) throw error;
            setProfile(data);
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

    // — Contrato PDF enviado pelo admin (iframe) —
    if (profile.contract_url) {
        return (
            <div className="space-y-4">
                {showDownloadButton && (
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <FileText size={18} className="text-tenant-primary" />
                            <span className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</span>
                        </div>
                        <a
                            href={profile.contract_url}
                            download
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-tenant-primary text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-transform"
                        >
                            <Download size={14} /> Baixar PDF
                        </a>
                    </div>
                )}
                <iframe
                    src={profile.contract_url}
                    className="w-full h-[70vh] rounded-2xl border border-brand-border"
                    title="Contrato do Aluno"
                />
            </div>
        );
    }

    // — Template digital gerado —
    let duration = 12;
    let planName = 'Plano Recorrente';
    if (profile.module?.includes('Semestral') || profile.modality === 'SEMESTER') { duration = 6; planName = 'Plano Semestral'; }
    else if (profile.module?.includes('Anual') || profile.modality === 'ANNUAL') { duration = 12; planName = 'Plano Anual'; }

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

    return (
        <div className="space-y-4">
            {/* Botões de ação — visíveis somente quando não há header externo */}
            {showDownloadButton && (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                        <FileText size={18} className="text-tenant-primary" />
                        <span className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleDownloadPdf}
                            disabled={downloading}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 hover:scale-105 transition-all shadow-lg disabled:opacity-50"
                        >
                            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                            {downloading ? 'Gerando...' : 'Baixar PDF'}
                        </button>
                    </div>
                </div>
            )}

            {/* Preview responsivo — usa CSS zoom para mostrar o A4 em tela pequena */}
            <div className="flex flex-col items-center overflow-x-hidden">
                <style>{`
                    .contract-preview-wrap { transform-origin: top center; }
                    @media (max-width: 400px)  { .contract-preview-wrap { zoom: 0.38; } }
                    @media (min-width: 401px) and (max-width: 639px)  { .contract-preview-wrap { zoom: 0.44; } }
                    @media (min-width: 640px) and (max-width: 1023px) { .contract-preview-wrap { zoom: 0.58; } }
                    @media (min-width: 1024px) { .contract-preview-wrap { zoom: 0.82; } }
                    @media (min-width: 1280px) { .contract-preview-wrap { zoom: 1; } }
                `}</style>
                <div className="contract-preview-wrap shadow-2xl">
                    <ContractDocument
                        innerRef={pdfRef}
                        studentName={profile.full_name || 'Aluno Wise Wolf'}
                        studentCPF={profile.cpf || '000.000.000-00'}
                        studentAddress={`${profile.address || ''}, ${profile.address_number || ''} - ${profile.postal_code || ''}`}
                        studentEmail={profile.email}
                        studentPhone={profile.phone || ''}
                        planName={planName}
                        planValue={monthlyFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        totalValue={totalValue}
                        planDuration={duration}
                        startDate={startDate}
                        endDate={endDate}
                        dueDay={profile.due_day || 10}
                        classFrequency={profile.class_frequency ? parseInt(String(profile.class_frequency)) : classFrequency}
                        acceptedAt={profile.accepted_at}
                        userIp={profile.signature_ip}
                        showPrintButton={false}
                    />
                </div>
            </div>
        </div>
    );
};

export default ContractView;
