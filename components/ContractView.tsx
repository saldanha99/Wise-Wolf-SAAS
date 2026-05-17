import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { ContractDocument } from './ContractDocument';
import { useReactToPrint } from 'react-to-print';
import { RefreshCw, Download, FileText } from 'lucide-react';

interface ContractViewProps {
    userId: string;
    classFrequency?: number | string;
    showDownloadButton?: boolean;
}

const ContractView: React.FC<ContractViewProps> = ({ userId, classFrequency = 2, showDownloadButton = true }) => {
    const [profile, setProfile] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const contractPrintRef = useRef<HTMLDivElement>(null);

    const handlePrint = useReactToPrint({
        contentRef: contractPrintRef,
        documentTitle: `Contrato_WiseWolf_${profile?.full_name?.replace(/\s+/g, '_') || 'Aluno'}`,
    });

    useEffect(() => {
        fetchContractData();
    }, [userId]);

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
        } catch (error) {
            console.error("Erro ao carregar contrato:", error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64 text-brand-muted gap-2">
                <RefreshCw className="animate-spin" /> Carregando Contrato...
            </div>
        );
    }

    if (!profile) return <div>Contrato não encontrado.</div>;

    // ✅ Priority: If an uploaded contract PDF exists, show it instead of the digital template
    if (profile.contract_url) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FileText size={20} className="text-tenant-primary" />
                        <h3 className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</h3>
                    </div>
                    <a
                        href={profile.contract_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 bg-tenant-primary text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-transform"
                    >
                        <Download size={14} /> Baixar PDF
                    </a>
                </div>
                <iframe
                    src={profile.contract_url}
                    className="w-full h-[70vh] rounded-2xl border border-brand-border"
                    title="Contrato do Aluno"
                />
            </div>
        );
    }

    // Fallback: Render digital contract template
    // Determine Duration based on Plan/Modality or default
    let duration = 12; // Default Anual
    let planName = 'Plano Recorrente';

    if (profile.module?.includes('Semestral') || profile.modality === 'SEMESTER') {
        duration = 6;
        planName = 'Plano Semestral';
    } else if (profile.module?.includes('Anual') || profile.modality === 'ANNUAL') {
        duration = 12;
        planName = 'Plano Anual';
    }

    // Format Dates — align start date with due_day
    const enrollmentDate = new Date(profile.created_at || new Date());
    const dueDay = profile.due_day || 1;
    // Build start date: same month as enrollment, but on the due_day.
    // If the enrollment day is already past the due_day, roll to the next month.
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
            {showDownloadButton && (
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FileText size={20} className="text-tenant-primary" />
                        <h3 className="font-black text-brand-text text-sm uppercase tracking-widest">Seu Contrato</h3>
                    </div>
                    <button
                        onClick={() => handlePrint()}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 hover:scale-105 transition-all shadow-lg"
                    >
                        <Download size={14} /> Baixar PDF
                    </button>
                </div>
            )}
            <div className="flex flex-col items-center overflow-x-hidden pt-4">
                <div ref={contractPrintRef} className="bg-brand-surface shadow-xl transition-all origin-top contract-view-zoom">
                    <style>{`
                        @media (max-width: 639px) { .contract-view-zoom { zoom: 0.43; } }
                        @media (min-width: 640px) and (max-width: 1023px) { .contract-view-zoom { zoom: 0.55; } }
                        @media (min-width: 1024px) { .contract-view-zoom { zoom: 0.8; } }
                        @media (min-width: 1280px) { .contract-view-zoom { zoom: 1; } }
                        @media print {
                            .contract-view-zoom { 
                                zoom: 1 !important; 
                                shadow: none !important;
                                margin: 0 !important;
                                padding: 0 !important;
                            }
                            @page {
                                size: auto;
                                margin: 0mm;
                            }
                            body {
                                margin: 0;
                            }
                        }
                    `}</style>
                    <div className="w-[800px] max-w-none transform-gpu">
                        <ContractDocument
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
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ContractView;
