import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { TeacherContractDocument } from './TeacherContractDocument';
import { Loader2, AlertCircle, FileText, Download } from 'lucide-react';

interface PublicContractViewProps {
    id?: string;
}

const PublicContractView: React.FC<PublicContractViewProps> = ({ id: propId }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [profile, setProfile] = useState<any>(null);
    const [resolvedId, setResolvedId] = useState<string | null>(propId || null);
    const [downloading, setDownloading] = useState(false);
    const contractRef = useRef<HTMLDivElement>(null);

    const handleDownloadPdf = async () => {
        const el = contractRef.current;
        if (!el) return;
        setDownloading(true);
        try {
            const html2pdf = (await import('html2pdf.js')).default;
            await html2pdf().set({
                margin: 0,
                filename: `Contrato_Professor_${(profile?.full_name || 'WiseWolf').replace(/\s+/g, '_')}.pdf`,
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
                // Rota pública (deslogado): lê os campos do contrato via RPC SECURITY DEFINER
                // (anon não tem SELECT direto em profiles após o fix de RLS cross-tenant).
                const { data, error: fetchError } = await supabase
                    .rpc('get_contract_public', { p_id: id });

                if (fetchError) throw fetchError;
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
    }, []);

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
        <div className="min-h-screen bg-gray-100 py-10">
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
                    disabled={downloading}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 transition-colors shadow-md disabled:opacity-50"
                >
                    {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {downloading ? 'Gerando...' : 'Baixar PDF'}
                </button>
            </div>

            {/* Documento do contrato — passamos o ref para captura pelo html2pdf */}
            <div ref={contractRef}>
                <TeacherContractDocument
                    teacherName={profile.full_name}
                    teacherRG={profile.rg}
                    teacherCPF={profile.cpf}
                    teacherAddress={profile.address}
                    teacherBirthDate={profile.birth_date}
                    hourlyRate={profile.hourly_rate}
                    acceptedAt={profile.accepted_at}
                    userIp={profile.user_ip}
                    subscriptionId={resolvedId || undefined}
                />
            </div>
        </div>
    );
};

export default PublicContractView;
