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
            const fileExt = file.name.split('.').pop();
            const fileName = `${user.id}/${closingId}_${Date.now()}.${fileExt}`;
            const filePath = `${fileName}`;

            // 1. Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('invoices')
                .upload(filePath, file);

            if (uploadError) {
                if (uploadError.message === 'Bucket not found') {
                    throw new Error('Bucket "invoices" não encontrado. Contate o suporte.');
                }
                throw uploadError;
            }

            // 2. Get Public URL
            const { data: { publicUrl } } = supabase.storage
                .from('invoices')
                .getPublicUrl(filePath);

            // 3. Update teacher_closings
            const { error: updateError } = await supabase
                .from('teacher_closings')
                .update({
                    nf_link: publicUrl,
                    status: 'EM ANÁLISE', // Force status update to trigger admin review
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

    const getStatusStyles = (status: string) => {
        switch (status?.toUpperCase()) {
            case 'PAGO':
                return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200';
            case 'CONFIRMADO':
                return 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border-blue-200';
            case 'PENDENTE':
            case 'EM ANÁLISE':
                return 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200';
            case 'REJEITADO':
            case 'CONTESTADO':
                return 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200';
            default:
                return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400 border-slate-200';
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500 pb-20">
            <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                    <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">Minhas Notas Fiscais</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Anexe as notas fiscais dos fechamentos confirmados para processamento do pagamento.</p>
                </div>
            </header>

            {/* History Table */}
            <div className="bg-white dark:bg-slate-900 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
                <div className="p-8 border-b dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex justify-between items-center">
                    <h3 className="font-black text-slate-700 dark:text-slate-200 text-xs uppercase tracking-widest flex items-center gap-2">
                        <FileUp size={16} className="text-tenant-primary" /> Envios Pendentes e Histórico
                    </h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50/50 dark:bg-slate-800/50 text-[10px] text-slate-400 dark:text-slate-500 uppercase font-black border-b dark:border-slate-800">
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
                                        <td colSpan={5} className="px-8 py-6"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-full"></div></td>
                                    </tr>
                                ))
                            ) : closings.length > 0 ? (
                                closings.map((inv) => (
                                    <tr key={inv.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group">
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2.5 bg-white dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-xl text-slate-400 group-hover:text-tenant-primary group-hover:border-tenant-primary/30 transition-all shadow-sm">
                                                    <Calendar size={18} />
                                                </div>
                                                <div>
                                                    <p className="font-black text-slate-700 dark:text-slate-200 text-sm">
                                                        {new Date(inv.month_year + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
                                                    </p>
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                                                        Ref: {inv.month_year}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-2">
                                                <Hash size={14} className="text-slate-300" />
                                                <span className="text-sm font-bold text-slate-600 dark:text-slate-400">
                                                    {inv.total_lessons} aulas
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <span className="font-black text-slate-800 dark:text-white text-lg tracking-tight">
                                                R$ {Number(inv.total_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center">
                                                <span className={`text-[10px] font-black px-4 py-1.5 rounded-full uppercase tracking-widest flex items-center gap-2 border ${getStatusStyles(inv.status)}`}>
                                                    {inv.status === 'PAGO' ? <CheckCircle size={12} /> :
                                                        inv.status === 'CONFIRMADO' ? <CheckCircle size={12} /> :
                                                            inv.status === 'PENDENTE' ? <Clock size={12} /> : <XCircle size={12} />}
                                                    {inv.status}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center flex-col items-center gap-2">
                                                {inv.nf_link ? (
                                                    <a
                                                        href={inv.nf_link}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="w-full justify-center px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-tenant-primary hover:text-white transition-all flex items-center gap-2 group/btn"
                                                    >
                                                        <FileText size={14} />
                                                        <span>Ver Nota Fiscal</span>
                                                        <Upload size={12} className="opacity-0 group-hover/btn:opacity-100 -ml-2 transition-opacity" />
                                                    </a>
                                                ) : (inv.status === 'CONFIRMADO' || inv.status === 'PAGO' || inv.status === 'REJEITADO') ? (
                                                    <div className="relative w-full">
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
                                                            className="w-full px-4 py-2 bg-tenant-primary text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-lg shadow-tenant-primary/20 flex items-center justify-center gap-2"
                                                            disabled={isUploadingFile === inv.id}
                                                        >
                                                            {isUploadingFile === inv.id ? (
                                                                <>
                                                                    <RefreshCw size={14} className="animate-spin" /> Enviando...
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Upload size={14} /> Anexar NF (PDF)
                                                                </>
                                                            )}
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <span className="text-[10px] font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest">
                                                        Aguardando Aprovação
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center justify-center text-slate-300 dark:text-slate-700">
                                            <FileText size={48} className="mb-4 opacity-20" />
                                            <p className="text-sm font-black uppercase tracking-widest">Nenhum fechamento disponível</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default TeacherInvoices;
