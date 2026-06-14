import React, { useState, useEffect } from 'react';
import { FileText, Upload, Clock, CheckCircle, XCircle, FileUp, AlertCircle, RefreshCw, Hash, Calendar } from 'lucide-react';
import { User as UserType } from '../types';
import { supabase } from '../lib/supabase';

interface TeacherInvoicesProps {
    user: UserType;
    tenantId?: string;
}

const TeacherInvoices: React.FC<TeacherInvoicesProps> = ({ user, tenantId }) => {
    const [closings, setClosings] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isUploadingFile, setIsUploadingFile] = useState<string | null>(null);

    useEffect(() => {
        if (user && tenantId) {
            fetchInvoicesData();
        }
    }, [user, tenantId]);

    const fetchInvoicesData = async () => {
        setLoading(true);
        try {
            // Fetch Teacher Closings (History)
            const { data: closingsData } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                .order('month_year', { ascending: false });

            if (closingsData) setClosings(closingsData);
        } catch (err) {
            console.error('Error fetching invoices:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileUpload = async (closingId: string, file: File) => {
        if (!file) return;
        if (file.type !== 'application/pdf') {
            alert('Por favor, envie apenas arquivos em formato PDF.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            alert('O arquivo é muito grande. O limite é 5MB.');
            return;
        }

        setIsUploadingFile(closingId);
        try {
            // DEBUG: Check what ID Supabase thinks we are
            const { data: { user: authUser } } = await supabase.auth.getUser();
            console.log("DEBUG: Current Auth User:", authUser);
            console.log("DEBUG: User ID sent to Storage:", authUser?.id);

            // If the user ID is "wise-wolf-school" (text), this IS the problem.
            // We cannot upload as this user to standard Supabase Storage.

            // Sanitize file path just in case
            const userIdToUse = authUser?.id || user.id || 'unknown';
            const cleanUserId = userIdToUse.replace(/[^a-zA-Z0-9]/g, '');
            const filePath = `user_${cleanUserId}/${Date.now()}_${file.name}`;

            // 1. Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('invoices')
                .upload(filePath, file, {
                    upsert: true
                });

            if (uploadError) {
                if (uploadError.message === 'Bucket not found') {
                    throw new Error('Bucket "invoices" não encontrado. Contate o suporte.');
                }
                throw uploadError;
            }

            // 2. Get Signed URL — o bucket "invoices" é PRIVADO; getPublicUrl gera link
            // que dá 403. Signed URL de longa duração permite o diretor abrir a NF.
            const { data: signed } = await supabase.storage
                .from('invoices')
                .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 5); // ~5 anos
            const nfUrl = signed?.signedUrl || filePath;

            // 3. Update teacher_closings (status UNDER_REVIEW = badge "Em Análise")
            const { error: updateError } = await supabase
                .from('teacher_closings')
                .update({
                    nf_link: nfUrl,
                    status: 'UNDER_REVIEW',
                    updated_at: new Date().toISOString()
                })
                .eq('id', closingId);

            if (updateError) throw updateError;

            alert('Nota Fiscal anexada com sucesso!');
            fetchInvoicesData();
        } catch (err: any) {
            alert('Erro no upload: ' + err.message);
        } finally {
            setIsUploadingFile(null);
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'COMPLETED':
                return <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-emerald-200">Aprovado</span>;
            case 'PAID_WAITING_NF':
                return <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-blue-200">Envie sua NF</span>;
            case 'UNDER_REVIEW':
                return <span className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-purple-200">Em Análise</span>;
            case 'REJECTED':
                return <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-red-200">Nota Rejeitada</span>;
            default:
                return <span className="bg-brand-surface-2 text-brand-text px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-brand-border">Pendente</span>;
        }
    };

    return (
        <div className="p-8 max-w-[1200px] mx-auto min-h-screen bg-brand-surface-2/50 dark:bg-brand-surface/50">
            <div className="mb-8">
                <div className="flex items-center gap-3 mb-2">
                    <div className="p-3 bg-tenant-primary/10 rounded-xl">
                        <FileText className="text-tenant-primary" size={24} />
                    </div>
                    <h1 className="text-3xl font-black text-brand-text tracking-tight">Minhas Notas Fiscais</h1>
                </div>
                <p className="text-brand-muted font-medium">Envie suas notas fiscais após o receber o pagamento para regularizar sua situação.</p>
            </div>

            {/* History Table */}
            <div className="bg-brand-surface rounded-[3rem] border border-brand-border shadow-xl overflow-hidden">
                <div className="p-8 border-b dark:border-brand-border bg-brand-surface-2/50 dark:bg-brand-surface-2/30 flex justify-between items-center">
                    <h3 className="font-black text-brand-text dark:text-slate-200 text-xs uppercase tracking-widest flex items-center gap-2">

                        <FileUp size={16} className="text-tenant-primary" /> Envios Pendentes e Histórico
                    </h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                        <thead>
                            <tr className="bg-brand-surface-2/50 dark:bg-brand-surface-2/50 text-[10px] text-brand-muted uppercase font-black border-b dark:border-brand-border">
                                <th className="px-8 py-5">Mês Referência</th>
                                <th className="px-8 py-5">Aulas</th>
                                <th className="px-8 py-5 text-right">Valor Total</th>
                                <th className="px-8 py-5 text-center">Status</th>
                                <th className="px-8 py-5 text-center">Ação / Arquivo</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {loading ? (
                                Array(3).fill(0).map((_, i) => (
                                    <tr key={i} className="animate-pulse">
                                        <td colSpan={5} className="px-8 py-6"><div className="h-4 bg-brand-surface-2 dark:bg-brand-surface-2 rounded w-full"></div></td>
                                    </tr>
                                ))
                            ) : closings.length > 0 ? (
                                closings.map((inv) => (
                                    <tr key={inv.id} className="hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/30 transition-all group">
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2.5 bg-brand-surface dark:bg-slate-950 border border-brand-border rounded-xl text-brand-muted group-hover:text-tenant-primary group-hover:border-tenant-primary/30 transition-all shadow-sm">
                                                    <Calendar size={18} />
                                                </div>
                                                <div>
                                                    <p className="font-black text-brand-text dark:text-slate-200 text-sm">
                                                        {new Date(inv.month_year + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
                                                    </p>
                                                    <p className="text-[10px] text-brand-muted font-bold uppercase tracking-wider">
                                                        Ref: {inv.month_year}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-2">
                                                <Hash size={14} className="text-slate-300" />
                                                <span className="text-sm font-bold text-brand-muted dark:text-brand-muted">
                                                    {inv.total_lessons} aulas
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <span className="font-black text-brand-text text-lg tracking-tight">
                                                R$ {Number(inv.total_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center">
                                                {getStatusBadge(inv.status)}
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center flex-col items-center gap-2">
                                                {(() => {
                                                    const status = inv.status || '';
                                                    const isRejected = status === 'REJECTED';
                                                    const hasLink = !!inv.nf_link;
                                                    // PENDENTE incluído: a maioria dos fechamentos fica PENDENTE e o professor
                                                    // precisa conseguir anexar a NF mesmo antes do diretor marcar como pago.
                                                    const canUpload = ['PENDENTE', 'REJECTED', 'CONFIRMADO', 'PAGO', 'PAID_WAITING_NF'].includes(status);

                                                    // 2. Se pode fazer upload (REJEITADO, CONFIRMADO, PAGO, WAIT_NF), Mostramos o Upload
                                                    // (Mesmo que tenha link, permitimos sobrescrever/corrigir)
                                                    if (canUpload) {
                                                        return (
                                                            <div className="relative w-full">
                                                                {/* Show Link if exists (for reference) */}
                                                                {hasLink && (
                                                                    <a href={inv.nf_link} target="_blank" className={`block text-[9px] text-center mb-1 hover:underline ${isRejected ? 'text-red-400' : 'text-blue-400'}`}>
                                                                        {isRejected ? 'Ver Nota Rejeitada' : 'Ver Nota Atual'}
                                                                    </a>
                                                                )}

                                                                <input
                                                                    type="file"
                                                                    accept=".pdf"
                                                                    className="absolute inset-0 opacity-0 cursor-pointer z-10"
                                                                    onChange={(e) => {
                                                                        const file = e.target.files?.[0];
                                                                        if (file) handleFileUpload(inv.id, file);
                                                                    }}
                                                                    disabled={isUploadingFile === inv.id}
                                                                />
                                                                <button
                                                                    className={`w-full px-4 py-2 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2 ${isRejected ? 'bg-red-500 shadow-red-500/20' : 'bg-tenant-primary shadow-tenant-primary/20'}`}
                                                                    disabled={isUploadingFile === inv.id}
                                                                >
                                                                    {isUploadingFile === inv.id ? (
                                                                        <><RefreshCw size={14} className="animate-spin" /> Enviando...</>
                                                                    ) : (
                                                                        <><Upload size={14} /> {isRejected ? 'Reenviar Nota' : 'Anexar NF (PDF)'}</>
                                                                    )}
                                                                </button>
                                                            </div>
                                                        );
                                                    }

                                                    // 3. Se tem Link mas NÃO pode fazer upload (Completed/Under Review), View Only
                                                    if (hasLink) {
                                                        return (
                                                            <a
                                                                href={inv.nf_link}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="w-full justify-center px-4 py-2 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-tenant-primary hover:text-white transition-all flex items-center gap-2 group/btn"
                                                            >
                                                                <FileText size={14} />
                                                                <span>Ver Nota Fiscal</span>
                                                                <Upload size={12} className="opacity-0 group-hover/btn:opacity-100 -ml-2 transition-opacity" />
                                                            </a>
                                                        );
                                                    }

                                                    // 4. Fallback (Aguardando Aprovação do Fechamento)
                                                    return (
                                                        <span className="text-[10px] font-bold text-slate-300 dark:text-brand-muted uppercase tracking-widest">
                                                            Aguardando Aprovação
                                                        </span>
                                                    );
                                                })()}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center justify-center text-slate-300 dark:text-brand-text">
                                            <FileText size={48} className="mb-4 opacity-20" />
                                            <p className="text-sm font-black uppercase tracking-widest">Nenhum fechamento disponível</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div >
        </div >
    );
};

export default TeacherInvoices;
