import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { CheckCircle, XCircle, FileText, Image, ExternalLink, Search, Loader2, AlertCircle, Eye, X, Download } from 'lucide-react';
import { ContractDocument } from './ContractDocument'; // Import the document component
import { useReactToPrint } from 'react-to-print';

interface StudentContract {
    user_id: string;
    student_name: string;
    student_email: string;
    student_cpf?: string;
    student_phone?: string;
    student_address?: string; // Need to ensure view fetches this or fetch profile
    plan_name: string;
    plan_value?: string;
    contract_accepted: boolean;
    accepted_at: string;
    student_signature_url: string | null;
    signed_document_url: string | null;
    documentation_status: 'PENDING' | 'APPROVED' | 'REJECTED';
    signature_ip: string;
    due_day?: number;
    class_frequency?: string;
    subscription_id?: string;
}

const ContractManagement: React.FC = () => {
    const [students, setStudents] = useState<StudentContract[]>([]);
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');

    // Modal States
    const [selectedStudent, setSelectedStudent] = useState<StudentContract | null>(null);
    const [isRejecting, setIsRejecting] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const directorContractRef = useRef<HTMLDivElement>(null);

    const handlePrintContract = useReactToPrint({
        contentRef: directorContractRef,
        documentTitle: `Contrato_WiseWolf_${selectedStudent?.student_name?.replace(/\s+/g, '_') || 'Aluno'}`,
    });

    useEffect(() => {
        fetchContracts();
    }, []);

    const fetchContracts = async () => {
        setLoading(true);
        try {
            // Fetch view + join with profile extra data if needed (view might need update or just fetch simplistic)
            // For now assume view has basic info, we might need a separate fetch for full contract details if missing
            // But let's work with what we have + maybe a single fetch when opening modal
            const { data, error } = await supabase
                .from('vw_student_contracts')
                .select('*')
                .eq('contract_accepted', true)
                .order('accepted_at', { ascending: false });

            if (error) throw error;

            // Enrich with data directly from view
            const enriched = data?.map(s => ({
                ...s,
                plan_name: 'Plano Wise Wolf',
                // Ensure number formatting
                plan_value: s.plan_value ? Number(s.plan_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00',
                student_address: s.student_address ? `${s.student_address}, ${s.student_address_number || ''} - ${s.student_postal_code || ''}` : 'Endereço não informado'
            })) || [];

            setStudents(enriched);
        } catch (error) {
            console.error('Error fetching contracts:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleValidation = async (userId: string, status: 'APPROVED' | 'REJECTED', reason?: string) => {
        setProcessing(userId);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ documentation_status: status })
                .eq('id', userId);

            if (error) throw error;

            if (status === 'REJECTED' && reason) {
                // Send Email via Edge Function
                const student = students.find(s => s.user_id === userId);
                await supabase.functions.invoke('send-rejection-email', {
                    body: { email: student?.student_email, studentName: student?.student_name, reason }
                });
            } else if (status === 'APPROVED') {
                // Send WhatsApp Welcome Message
                const student = students.find(s => s.user_id === userId);
                await supabase.functions.invoke('whatsapp-notificacao-wise', {
                    body: {
                        type: 'STUDENT_APPROVED',
                        data: {
                            student_name: student?.student_name,
                            student_phone: student?.student_phone,
                            portal_link: window.location.origin
                        }
                    }
                });
            }

            // Client Update
            setStudents(prev => prev.map(s =>
                s.user_id === userId ? { ...s, documentation_status: status } : s
            ));

            // Close Modals
            setSelectedStudent(null);
            setIsRejecting(false);
            setRejectReason('');

        } catch (error) {
            console.error('Error updating status:', error);
            alert('Erro ao atualizar status. Tente novamente.');
        } finally {
            setProcessing(null);
        }
    };

    const filteredStudents = students.filter(s =>
        s.student_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.student_email?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-brand-surface p-4 rounded-2xl shadow-sm border border-brand-border">
                <h3 className="text-lg font-bold text-brand-text flex items-center gap-2">
                    <FileText className="text-[#002366]" /> Auditoria de Matrículas
                </h3>
                <div className="relative w-full md:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={20} />
                    <input
                        type="text"
                        placeholder="Buscar aluno..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 rounded-xl border border-brand-border focus:outline-none focus:ring-2 focus:ring-[#002366] transition-all"
                    />
                </div>
            </div>

            {/* Table */}
            <div className="bg-brand-surface rounded-3xl shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-brand-surface-2 text-brand-muted font-semibold border-b border-brand-border">
                            <tr>
                                <th className="px-6 py-4">Aluno</th>
                                <th className="px-6 py-4">Data Matrícula</th>
                                <th className="px-6 py-4">Assinatura</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {loading ? (
                                <tr><td colSpan={5} className="text-center py-10"><Loader2 className="animate-spin mx-auto" /></td></tr>
                            ) : filteredStudents.length === 0 ? (
                                <tr><td colSpan={5} className="text-center py-10 text-brand-muted">Nenhum registro.</td></tr>
                            ) : (
                                filteredStudents.map((student) => {
                                    const isUploadSig = !!student.student_signature_url;
                                    const isUploadDoc = !!student.signed_document_url;

                                    return (
                                        <tr key={student.user_id} className="hover:bg-brand-surface-2/50">
                                            <td className="px-6 py-4">
                                                <p className="font-bold text-brand-text">{student.student_name}</p>
                                                <p className="text-xs text-brand-muted">{student.student_email}</p>
                                            </td>
                                            <td className="px-6 py-4 text-brand-muted">
                                                {new Date(student.accepted_at).toLocaleDateString()}
                                            </td>
                                            <td className="px-6 py-4">
                                                {isUploadDoc ? <span className="badge-purple">Upload Completo</span> :
                                                    isUploadSig ? <span className="badge-blue">Foto Assinatura</span> :
                                                        <span className="badge-emerald">Digital</span>}
                                            </td>
                                            <td className="px-6 py-4">
                                                {student.documentation_status === 'APPROVED' ?
                                                    <span className="text-emerald-600 font-bold flex gap-1"><CheckCircle size={14} /> OK</span> :
                                                    student.documentation_status === 'REJECTED' ?
                                                        <span className="text-red-600 font-bold flex gap-1"><XCircle size={14} /> Rejeitado</span> :
                                                        <span className="text-orange-500 font-bold flex gap-1"><AlertCircle size={14} /> Pendente</span>
                                                }
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <button
                                                    onClick={() => setSelectedStudent(student)}
                                                    className="bg-brand-surface-2 p-2 rounded-lg hover:bg-slate-200 transition-colors text-brand-muted"
                                                >
                                                    <Eye size={18} />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* --- AUDIT MODAL --- */}
            {selectedStudent && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
                    <div className="bg-brand-surface rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">

                        {/* Modal Header */}
                        <div className="flex justify-between items-center p-6 border-b border-gray-100">
                            <div>
                                <h2 className="text-2xl font-bold text-[#002366]">Auditoria de Contrato</h2>
                                <p className="text-sm text-gray-500">Verifique os dados antes de aprovar.</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => handlePrintContract()}
                                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#002366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-900 hover:scale-105 transition-all shadow-lg"
                                >
                                    <Download size={14} /> Baixar PDF
                                </button>
                                <button onClick={() => setSelectedStudent(null)} className="p-2 hover:bg-gray-100 rounded-full">
                                    <X size={24} />
                                </button>
                            </div>
                        </div>

                        {/* Modal Body */}
                        <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                            <div className="flex flex-col lg:flex-row gap-8">

                                {/* Left: Contract Preview */}
                                <div className="flex-1 bg-brand-surface p-4 shadow-sm rounded-xl border border-gray-200 min-h-[500px] overflow-auto origin-top contract-management-zoom">
                                    <style>{`
                                        @media (max-width: 639px) { .contract-management-zoom { zoom: 0.43; } }
                                        @media (min-width: 640px) and (max-width: 1023px) { .contract-management-zoom { zoom: 0.55; } }
                                        @media (min-width: 1024px) { .contract-management-zoom { zoom: 0.8; } }
                                        @media (min-width: 1280px) { .contract-management-zoom { zoom: 0.9; } }
                                        @media print {
                                            .contract-management-zoom { 
                                                zoom: 1 !important; 
                                                shadow: none !important;
                                                margin: 0 !important;
                                                padding: 0 !important;
                                            }
                                            @page {
                                                size: auto;
                                                margin: 0mm;
                                            }
                                        }
                                    `}</style>
                                    <h4 className="font-bold text-gray-400 mb-4 uppercase text-xs tracking-wider">Visualização do Contrato</h4>
                                    <div ref={directorContractRef} className="pointer-events-none select-none w-[800px] max-w-none transform-gpu">
                                        {(() => {
                                            const enroll = new Date(selectedStudent.accepted_at);
                                            const dd = selectedStudent.due_day || 1;
                                            let s = new Date(enroll.getFullYear(), enroll.getMonth(), dd);
                                            if (enroll.getDate() > dd) s = new Date(enroll.getFullYear(), enroll.getMonth() + 1, dd);
                                            const e = new Date(s.getFullYear(), s.getMonth() + 12, dd);
                                            const fee = Number(String(selectedStudent.plan_value || '0').replace(/\./g, '').replace(',', '.'));
                                            return (
                                                <ContractDocument
                                                    studentName={selectedStudent.student_name}
                                                    studentCPF={selectedStudent.student_cpf || '000.000.000-00'}
                                                    studentAddress={selectedStudent.student_address || ''}
                                                    studentEmail={selectedStudent.student_email}
                                                    studentPhone={selectedStudent.student_phone || ''}
                                                    planName={selectedStudent.plan_name}
                                                    planValue={selectedStudent.plan_value || '0,00'}
                                                    totalValue={(fee * 12).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                                    planDuration={12}
                                                    startDate={s.toLocaleDateString('pt-BR')}
                                                    endDate={e.toLocaleDateString('pt-BR')}
                                                    dueDay={dd}
                                                    classFrequency={selectedStudent.class_frequency ? parseInt(String(selectedStudent.class_frequency)) : 2}
                                                    acceptedAt={selectedStudent.accepted_at}
                                                    userIp={selectedStudent.signature_ip}
                                                    subscriptionId={selectedStudent.subscription_id}
                                                />
                                            );
                                        })()}
                                    </div>
                                </div>

                                {/* Right: Evidence & Actions */}
                                <div className="w-full lg:w-96 flex flex-col gap-6">

                                    {/* Evidence Card */}
                                    <div className="bg-brand-surface p-6 rounded-xl border border-gray-200 shadow-sm">
                                        <h4 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
                                            <Image size={18} className="text-blue-600" /> Evidências
                                        </h4>
                                        {selectedStudent.student_signature_url ? (
                                            <div className="border rounded-lg p-2 bg-brand-surface-2">
                                                <p className="text-xs text-brand-muted mb-2">Assinatura Enviada:</p>
                                                <img src={selectedStudent.student_signature_url} className="w-full h-auto rounded border" alt="Assinatura" />
                                                <a href={selectedStudent.student_signature_url} target="_blank" className="text-xs text-blue-600 mt-2 block underline">Abrir Original</a>
                                            </div>
                                        ) : selectedStudent.signed_document_url ? (
                                            <div className="border rounded-lg p-4 bg-purple-50 text-center">
                                                <FileText size={32} className="mx-auto text-purple-600 mb-2" />
                                                <p className="text-sm font-bold text-purple-900">PDF Completo Enviado</p>
                                                <a href={selectedStudent.signed_document_url} target="_blank" className="text-xs text-purple-600 mt-2 inline-block underline">Visualizar PDF</a>
                                            </div>
                                        ) : (
                                            <div className="border rounded-lg p-4 bg-emerald-50 text-center">
                                                <CheckCircle size={32} className="mx-auto text-emerald-600 mb-2" />
                                                <p className="text-sm font-bold text-emerald-900">Assinatura Digital</p>
                                                <p className="text-xs text-emerald-700">Autenticada por IP</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Actions Card */}
                                    <div className="bg-brand-surface p-6 rounded-xl border border-gray-200 shadow-sm mt-auto">
                                        {!isRejecting ? (
                                            <div className="space-y-3">
                                                <button
                                                    onClick={() => handleValidation(selectedStudent.user_id, 'APPROVED')}
                                                    disabled={!!processing || selectedStudent.documentation_status === 'APPROVED'}
                                                    className="w-full py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition flex justify-center gap-2 disabled:opacity-50"
                                                >
                                                    {processing ? <Loader2 className="animate-spin" /> : <CheckCircle />}
                                                    Aprovar Documentação
                                                </button>

                                                <button
                                                    onClick={() => setIsRejecting(true)}
                                                    disabled={!!processing || selectedStudent.documentation_status === 'REJECTED'}
                                                    className="w-full py-3 bg-brand-surface border-2 border-red-100 text-red-600 rounded-xl font-bold hover:bg-red-50 transition flex justify-center gap-2"
                                                >
                                                    <XCircle /> Rejeitar
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="animate-in fade-in slide-in-from-bottom-2">
                                                <h5 className="font-bold text-red-700 mb-2">Motivo da Rejeição</h5>
                                                <textarea
                                                    className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-red-500 outline-none mb-3"
                                                    rows={3}
                                                    placeholder="Ex: Assinatura ilegível..."
                                                    value={rejectReason}
                                                    onChange={(e) => setRejectReason(e.target.value)}
                                                />
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => setIsRejecting(false)}
                                                        className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg font-semibold"
                                                    >
                                                        Cancelar
                                                    </button>
                                                    <button
                                                        onClick={() => handleValidation(selectedStudent.user_id, 'REJECTED', rejectReason)}
                                                        className="flex-1 py-2 bg-red-600 text-white rounded-lg font-bold hover:bg-red-700"
                                                        disabled={!rejectReason}
                                                    >
                                                        Confirmar
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ContractManagement;
