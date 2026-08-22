import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { TeacherContractDocument, getTeacherContractReadiness } from './TeacherContractDocument';
import type { SchoolInfo } from './ContractDocument';
import { Loader2, AlertCircle, FileText, Download } from 'lucide-react';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';

interface PublicContractViewProps {
    id?: string;
}

const PublicContractView: React.FC<PublicContractViewProps> = ({ id: propId }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [profile, setProfile] = useState<any>(null);
    const [resolvedId, setResolvedId] = useState<string | null>(propId || null);
    const [downloading, setDownloading] = useState(false);
    const contractPdfRef = useRef<HTMLDivElement>(null);
    const schoolInfo = profile?.schoolInfo && typeof profile.schoolInfo === 'object'
        ? profile.schoolInfo as SchoolInfo
        : profile?.school_info && typeof profile.school_info === 'object'
            ? profile.school_info as SchoolInfo
            : null;
    const contractReadiness = getTeacherContractReadiness(schoolInfo, profile?.hourly_rate);

    const handleDownloadPdf = async () => {
        const el = contractPdfRef.current;
        if (!el) return;
        if (!contractReadiness.isReady) {
            alert(`Download bloqueado: a escola precisa configurar ${contractReadiness.missingFields.join(', ')}.`);
            return;
        }
        setDownloading(true);
        try {
            const html2pdf = (await import('html2pdf.js')).default;
            await html2pdf().set({
                margin: 0,
                filename: `Contrato_Professor_${(profile?.full_name || 'Professor').replace(/\s+/g, '_')}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            }).from(el).save();
        } catch (err) {
            console.error('Erro ao gerar PDF do professor:', err);
            alert('Erro ao gerar PDF. Tente usar o botão Imprimir.');
        } finally {
            setDownloading(false);
        }
    };

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = propId || params.get('id');
        setResolvedId(id);

        if (!id) {
            setError("ID do contrato não fornecido.");
            setLoading(false);
            return;
        }

        const fetchProfile = async () => {
            try {
                const { data: authData } = await supabase.auth.getUser();
                if (!authData.user) {
                    throw new Error('Entre no portal para acessar este contrato. Links públicos antigos foram desativados por segurança.');
                }
                // A função valida usuário + tenant e materializa somente uma URL
                // curta da assinatura privada registrada no snapshot imutável.
                const data = await tenantLegalAssetsService.teacherContract(id);
                if (!data || !data.full_name) throw new Error("Contrato não encontrado.");

                setProfile(data);
            } catch (err: any) {
                console.error(err);
                setError(err.message || "Erro ao carregar o contrato.");
            } finally {
                setLoading(false);
            }
        };

        fetchProfile();
    }, [propId]);

    if (loading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface-2 gap-4">
                <Loader2 className="animate-spin text-tenant-primary" size={48} />
                <p className="text-brand-muted font-bold uppercase tracking-widest text-xs">Autenticando Contrato...</p>
            </div>
        );
    }

    if (error || !profile) {
        return (
            <div className="min-h-screen bg-brand-surface-2 flex items-center justify-center p-4">
                <div className="bg-brand-surface p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-brand-text mb-2">Erro na Visualização</h2>
                    <p className="text-brand-muted mb-6">{error}</p>
                    <a href="/" className="text-tenant-primary font-bold hover:underline">Ir para o Portal</a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-100 py-4 sm:py-10">
            {/* Barra de ação: header de segurança + botão de download */}
            <div className="max-w-[210mm] mx-auto mb-4 px-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-brand-muted">
                    <FileText size={16} />
                    <span className="text-[10px] font-black uppercase tracking-widest">Documento Digital Autêntico</span>
                    <span className="text-[10px] font-bold ml-2">ID: {resolvedId?.substring(0, 8)}...</span>
                </div>
                {/* Botão de download PDF — funciona em mobile e desktop */}
                <button
                    onClick={handleDownloadPdf}
                    disabled={downloading || !contractReadiness.isReady}
                    title={!contractReadiness.isReady ? 'Dados jurídicos ou financeiros indisponíveis neste documento.' : undefined}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 transition-colors shadow-md disabled:opacity-50"
                >
                    {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {downloading ? 'Gerando...' : 'Baixar PDF'}
                </button>
            </div>

            {!contractReadiness.isReady && (
                <div role="alert" className="mx-auto mb-4 max-w-[210mm] px-4">
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                        <p className="font-black uppercase tracking-wide">Documento sem snapshot jurídico do tenant</p>
                        <p className="mt-1">A impressão foi bloqueada. Solicite à escola uma nova via com identidade e assinatura próprias configuradas.</p>
                    </div>
                </div>
            )}

            {/* Leitura fluida na tela; o clone A4 abaixo é exclusivo do PDF. */}
            <div className="mx-auto w-full max-w-[210mm] px-3 sm:px-4">
                <TeacherContractDocument
                    teacherName={profile.full_name}
                    teacherRG={profile.rg}
                    teacherCPF={profile.cpf}
                    teacherAddress={profile.address}
                    teacherBirthDate={profile.birth_date}
                    school={schoolInfo}
                    hourlyRate={profile.hourly_rate}
                    acceptedAt={profile.accepted_at}
                    userIp={profile.user_ip}
                    subscriptionId={resolvedId || undefined}
                    displayMode="responsive"
                    showPrintButton={false}
                />
            </div>
            <div
                aria-hidden="true"
                style={{ position: 'fixed', left: '-12000px', top: 0, width: '210mm', pointerEvents: 'none' }}
            >
                <TeacherContractDocument
                    teacherName={profile.full_name}
                    teacherRG={profile.rg}
                    teacherCPF={profile.cpf}
                    teacherAddress={profile.address}
                    teacherBirthDate={profile.birth_date}
                    school={schoolInfo}
                    hourlyRate={profile.hourly_rate}
                    acceptedAt={profile.accepted_at}
                    userIp={profile.user_ip}
                    subscriptionId={resolvedId || undefined}
                    displayMode="a4"
                    showPrintButton={false}
                    innerRef={contractPdfRef}
                />
            </div>
        </div>
    );
};

export default PublicContractView;
