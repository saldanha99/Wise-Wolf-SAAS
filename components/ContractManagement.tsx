import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { contractReferenceDate, formatContractPeriod, formatSignatureDate } from '../lib/contractDates';
import { CheckCircle, XCircle, FileText, Image, ExternalLink, Search, Loader2, AlertCircle, Eye, X, Download } from 'lucide-react';
import { ContractDocument, getSchoolContractIdentity, type SchoolInfo } from './ContractDocument';
import { getSchoolInfo } from '../lib/schoolInfo';

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
    rejection_reason?: string | null;
    signature_ip: string;
    due_day?: number;
    class_frequency?: string;
    subscription_id?: string;
    tenant_id?: string;
}

interface ContractManagementProps {
    tenantId?: string;
}

const ContractManagement: React.FC<ContractManagementProps> = ({ tenantId }) => {
    const [students, setStudents] = useState<StudentContract[]>([]);
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [schoolInfo, setSchoolInfo] = useState<SchoolInfo | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [actionNotice, setActionNotice] = useState<{
        tone: 'success' | 'warning';
        message: string;
    } | null>(null);

    // Modal States
    const [selectedStudent, setSelectedStudent] = useState<StudentContract | null>(null);
    const [isRejecting, setIsRejecting] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const directorContractRef = useRef<HTMLDivElement>(null);
    const auditDialogRef = useRef<HTMLDivElement>(null);
    const processingRef = useRef<string | null>(null);
    const schoolIdentity = getSchoolContractIdentity(schoolInfo);

    useEffect(() => {
        processingRef.current = processing;
    }, [processing]);

    const handleDownloadContract = async () => {
        if (!directorContractRef.current || !selectedStudent) return;
        if (!schoolIdentity.isReady) {
            alert(`Download bloqueado: configure ${schoolIdentity.missingFields.join(', ')} para esta escola.`);
            return;
        }
        setDownloading(true);
        try {
            const html2pdf = (await import('html2pdf.js')).default;
            await html2pdf().set({
                margin: 0,
                filename: `Contrato_${selectedStudent.student_name.replace(/\s+/g, '_')}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            }).from(directorContractRef.current).save();
        } catch (error) {
            console.error('Contract PDF error:', error);
            alert('Não foi possível gerar o PDF. Tente novamente.');
        } finally {
            setDownloading(false);
        }
    };

    useEffect(() => {
        fetchContracts();
        if (tenantId) fetchSchoolInfo(tenantId);
    }, [tenantId]);

    useEffect(() => {
        if (!selectedStudent) return;
        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        document.body.style.overflow = 'hidden';
        const focusFrame = window.requestAnimationFrame(() => auditDialogRef.current?.focus());
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !processingRef.current) {
                setSelectedStudent(null);
                return;
            }
            if (event.key !== 'Tab' || !auditDialogRef.current) return;

            const focusable = Array.from(
                auditDialogRef.current.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
                )
            ) as HTMLElement[];
            if (focusable.length === 0) {
                event.preventDefault();
                auditDialogRef.current.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === auditDialogRef.current)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', handleKeyDown);
            previousFocus?.focus();
        };
    }, [selectedStudent]);

    const fetchSchoolInfo = async (tid: string) => {
        try {
            setSchoolInfo(await getSchoolInfo(tid));
        } catch (_) {
            setSchoolInfo(null);
        }
    };

    const fetchContracts = async () => {
        setLoading(true);
        setLoadError(null);
        try {
            // Fetch view + join with profile extra data if needed (view might need update or just fetch simplistic)
            // For now assume view has basic info, we might need a separate fetch for full contract details if missing
            // But let's work with what we have + maybe a single fetch when opening modal
            let query = supabase
                .from('vw_student_contracts')
                .select('*')
                .eq('contract_accepted', true);
            if (tenantId) query = query.eq('tenant_id', tenantId);
            const { data, error } = await query.order('accepted_at', { ascending: false });

            if (error) throw error;

            // Enrich with data directly from view
            const enriched = data?.map(s => ({
                ...s,
                plan_name: 'Plano contratado',
                // Ensure number formatting
                plan_value: s.plan_value ? Number(s.plan_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00',
                student_address: s.student_address ? `${s.student_address}, ${s.student_address_number || ''} - ${s.student_postal_code || ''}` : 'Endereço não informado'
            })) || [];

            setStudents(enriched);
        } catch (error) {
            console.error('Error fetching contracts:', error);
            setStudents([]);
            setLoadError('Não foi possível carregar as matrículas para auditoria.');
        } finally {
            setLoading(false);
        }
    };

    const handleValidation = async (userId: string, status: 'APPROVED' | 'REJECTED', reason?: string) => {
        const normalizedReason = reason?.trim() || '';
        if (status === 'REJECTED' && normalizedReason.length < 3) {
            alert('Informe um motivo com pelo menos 3 caracteres.');
            return;
        }
        setProcessing(userId);
        setActionNotice(null);
        try {
            let updateQuery = supabase
                .from('profiles')
                .update({
                    documentation_status: status,
                    rejection_reason: status === 'REJECTED' ? normalizedReason : null,
                })
                .eq('id', userId);
            if (tenantId) updateQuery = updateQuery.eq('tenant_id', tenantId);
            const { data: updatedProfile, error } = await updateQuery
                .select('id')
                .maybeSingle();

            if (error) throw error;
            if (!updatedProfile) throw new Error('O aluno não pertence a esta unidade.');

            let communicationWarning = '';
            let communicationSkipped = false;
            if (status === 'REJECTED' && reason) {
                // Send Email via Edge Function
                const student = students.find(s => s.user_id === userId);
                const { data: emailResult, error: emailError } = await supabase.functions.invoke('send-rejection-email', {
                    body: { student_id: student?.user_id }
                });
                if (emailError) {
                    communicationWarning = 'A rejeição foi salva, mas o e-mail não pôde ser enviado. Reabra o contrato para tentar novamente.';
                } else if (emailResult?.skipped === 'test_fixture') {
                    communicationSkipped = true;
                }
            } else if (status === 'APPROVED') {
                // Enfileira o WhatsApp com idempotência; o worker faz as tentativas.
                const student = students.find(s => s.user_id === userId);
                const { data: notificationResult, error: notificationError } = await supabase.functions.invoke('whatsapp-notificacao-wise', {
                    body: {
                        type: 'STUDENT_APPROVED',
                        data: {
                            student_id: student?.user_id
                        }
                    }
                });
                if (notificationError) {
                    communicationWarning = 'A aprovação foi salva, mas o aviso não entrou na fila. Reabra o contrato para tentar novamente.';
                } else if (notificationResult?.skipped === 'test_fixture') {
                    communicationSkipped = true;
                }
            }

            // Client Update
            setStudents(prev => prev.map(s =>
                s.user_id === userId
                    ? {
                        ...s,
                        documentation_status: status,
                        rejection_reason: status === 'REJECTED' ? normalizedReason : null,
                    }
                    : s
            ));

            // Close Modals
            setSelectedStudent(null);
            setIsRejecting(false);
            setRejectReason('');
            setActionNotice({
                tone: communicationWarning ? 'warning' : 'success',
                message: communicationWarning ||
                    (communicationSkipped
                        ? 'Registro atualizado. Por ser uma conta de teste, nenhuma comunicação externa foi enviada.'
                        : status === 'APPROVED'
                            ? 'Documentação aprovada e comunicação registrada.'
                            : 'Rejeição salva e comunicação registrada.'),
            });

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
    const selectedContractProps = selectedStudent ? (() => {
        // accepted_at é NULO enquanto o aluno não assinou. `new Date(null)` vira
        // o epoch — e no fuso de Brasília isso é 31/12/1969, o que empurrava a
        // vigência para "10/01/1970 a 10/01/1971" no contrato impresso.
        const enrollmentDate = contractReferenceDate(selectedStudent.accepted_at);
        const dueDay = selectedStudent.due_day || 1;
        const { startDate, endDate } = formatContractPeriod(enrollmentDate, dueDay, 12);
        const monthlyFee = Number(String(selectedStudent.plan_value || '0').replace(/\./g, '').replace(',', '.'));
        return {
            studentName: selectedStudent.student_name,
            studentCPF: selectedStudent.student_cpf || '',
            studentAddress: selectedStudent.student_address || '',
            studentEmail: selectedStudent.student_email,
            studentPhone: selectedStudent.student_phone || '',
            planName: selectedStudent.plan_name,
            planValue: selectedStudent.plan_value || '0,00',
            totalValue: (monthlyFee * 12).toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
            planDuration: 12,
            startDate,
            endDate,
            dueDay,
            classFrequency: selectedStudent.class_frequency ? parseInt(String(selectedStudent.class_frequency), 10) : 2,
            acceptedAt: selectedStudent.accepted_at,
            userIp: selectedStudent.signature_ip,
            subscriptionId: selectedStudent.subscription_id,
            school: schoolInfo ?? undefined,
        };
    })() : null;

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

            {loadError && (
                <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200 sm:flex-row sm:items-center" role="alert">
                    <span className="flex items-center gap-2 text-sm font-bold"><AlertCircle size={18} /> {loadError}</span>
                    <button type="button" onClick={fetchContracts} className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white">Tentar novamente</button>
                </div>
            )}

            {actionNotice && (
                <div
                    role="status"
                    className={`flex items-start justify-between gap-3 rounded-2xl border p-4 text-sm font-bold ${
                        actionNotice.tone === 'warning'
                            ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-100'
                    }`}
                >
                    <span>{actionNotice.message}</span>
                    <button
                        type="button"
                        onClick={() => setActionNotice(null)}
                        aria-label="Fechar aviso"
                        className="shrink-0 rounded-full p-1 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>
            )}

            <div className="space-y-3 md:hidden">
                {loading ? (
                    <div className="rounded-2xl border border-brand-border bg-brand-surface p-8 text-center" role="status">
                        <Loader2 className="mx-auto animate-spin" />
                        <span className="sr-only">Carregando matrículas</span>
                    </div>
                ) : !loadError && filteredStudents.length === 0 ? (
                    <div className="rounded-2xl border border-brand-border bg-brand-surface p-8 text-center text-sm text-brand-muted">Nenhum registro.</div>
                ) : filteredStudents.map((student) => {
                    const signatureLabel = student.signed_document_url
                        ? 'Upload completo'
                        : student.student_signature_url
                            ? 'Foto da assinatura'
                            : 'Assinatura digital';
                    return (
                        <article key={student.user_id} className="space-y-4 rounded-2xl border border-brand-border bg-brand-surface p-4 shadow-sm">
                            <div className="min-w-0">
                                <p className="font-bold text-brand-text">{student.student_name}</p>
                                <p className="break-anywhere text-xs text-brand-muted">{student.student_email}</p>
                            </div>
                            <dl className="grid grid-cols-2 gap-3 text-xs">
                                <div>
                                    <dt className="font-bold uppercase tracking-wide text-brand-muted">Matrícula</dt>
                                    <dd className="mt-1 text-brand-text">{formatSignatureDate(student.accepted_at)}</dd>
                                </div>
                                <div>
                                    <dt className="font-bold uppercase tracking-wide text-brand-muted">Assinatura</dt>
                                    <dd className="mt-1 text-brand-text">{signatureLabel}</dd>
                                </div>
                                <div className="col-span-2">
                                    <dt className="font-bold uppercase tracking-wide text-brand-muted">Status</dt>
                                    <dd className={`mt-1 font-bold ${student.documentation_status === 'APPROVED' ? 'text-emerald-600' : student.documentation_status === 'REJECTED' ? 'text-red-600' : 'text-orange-600'}`}>
                                        {student.documentation_status === 'APPROVED' ? 'Aprovado' : student.documentation_status === 'REJECTED' ? 'Rejeitado' : 'Pendente'}
                                    </dd>
                                </div>
                            </dl>
                            <button
                                type="button"
                                onClick={() => setSelectedStudent(student)}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#002366] px-4 py-3 text-sm font-bold text-white"
                            >
                                <Eye size={17} /> Inspecionar contrato
                            </button>
                        </article>
                    );
                })}
            </div>

            {/* Table */}
            <div className="hidden bg-brand-surface rounded-3xl shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 overflow-hidden md:block">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm min-w-[600px]">
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
                                                {formatSignatureDate(student.accepted_at)}
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
                                                    type="button"
                                                    onClick={() => setSelectedStudent(student)}
                                                    aria-label={`Inspecionar contrato de ${student.student_name}`}
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
            {selectedStudent && selectedContractProps && createPortal(
                <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 animate-in fade-in sm:p-4">
                    <div ref={auditDialogRef} role="dialog" aria-modal="true" aria-labelledby="audit-contract-title" tabIndex={-1} className="flex h-dvh max-h-dvh w-full max-w-6xl flex-col overflow-hidden bg-brand-surface shadow-2xl outline-none sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl">

                        {/* Modal Header */}
                        <div className="flex flex-col justify-between gap-3 border-b border-gray-100 p-4 sm:flex-row sm:items-center sm:p-6">
                            <div className="min-w-0">
                                <h2 id="audit-contract-title" className="text-xl font-bold text-[#002366] sm:text-2xl">Auditoria de Contrato</h2>
                                <p className="text-sm text-gray-500">Verifique os dados antes de aprovar.</p>
                            </div>
                            <div className="flex w-full items-center gap-2 sm:w-auto sm:gap-3">
                                <button
                                    type="button"
                                    onClick={handleDownloadContract}
                                    disabled={downloading || !schoolIdentity.isReady}
                                    title={!schoolIdentity.isReady ? 'Complete a identidade jurídica e a assinatura desta escola.' : undefined}
                                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#002366] px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:bg-blue-900 disabled:opacity-50 sm:flex-none"
                                >
                                    {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {downloading ? 'Gerando' : 'Baixar PDF'}
                                </button>
                                <button type="button" onClick={() => setSelectedStudent(null)} aria-label="Fechar auditoria do contrato" className="shrink-0 p-2 hover:bg-gray-100 rounded-full">
                                    <X size={24} />
                                </button>
                            </div>
                        </div>

                        {/* Modal Body */}
                        <div className="flex-1 overflow-y-auto bg-gray-50 p-2 sm:p-6">
                            <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">

                                {/* Left: Contract Preview */}
                                <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-gray-200 bg-brand-surface p-2 shadow-sm sm:p-4">
                                    <h4 className="font-bold text-gray-400 mb-4 uppercase text-xs tracking-wider">Visualização do Contrato</h4>
                                    <div className="select-text">
                                        <ContractDocument {...selectedContractProps} displayMode="responsive" showPrintButton={false} />
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
                                                <a href={selectedStudent.student_signature_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 mt-2 block underline">Abrir Original</a>
                                            </div>
                                        ) : selectedStudent.signed_document_url ? (
                                            <div className="border rounded-lg p-4 bg-purple-50 text-center">
                                                <FileText size={32} className="mx-auto text-purple-600 mb-2" />
                                                <p className="text-sm font-bold text-purple-900">PDF Completo Enviado</p>
                                                <a href={selectedStudent.signed_document_url} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-600 mt-2 inline-block underline">Visualizar PDF</a>
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
                                                    type="button"
                                                    onClick={() => handleValidation(selectedStudent.user_id, 'APPROVED')}
                                                    disabled={!!processing}
                                                    className="w-full py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition flex justify-center gap-2 disabled:opacity-50"
                                                >
                                                    {processing ? <Loader2 className="animate-spin" /> : <CheckCircle />}
                                                    {selectedStudent.documentation_status === 'APPROVED'
                                                        ? 'Reenviar aviso de aprovação'
                                                        : 'Aprovar Documentação'}
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setRejectReason(selectedStudent.rejection_reason || '');
                                                        setIsRejecting(true);
                                                    }}
                                                    disabled={!!processing}
                                                    className="w-full py-3 bg-brand-surface border-2 border-red-100 text-red-600 rounded-xl font-bold hover:bg-red-50 transition flex justify-center gap-2"
                                                >
                                                    <XCircle /> {selectedStudent.documentation_status === 'REJECTED'
                                                        ? 'Reenviar solicitação de correção'
                                                        : 'Rejeitar'}
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
                                                        type="button"
                                                        onClick={() => setIsRejecting(false)}
                                                        className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg font-semibold"
                                                    >
                                                        Cancelar
                                                    </button>
                                                    <button
                                                        type="button"
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
                    <div aria-hidden="true" style={{ position: 'fixed', left: '-12000px', top: 0, width: '210mm', zIndex: -1, pointerEvents: 'none' }}>
                        <ContractDocument {...selectedContractProps} displayMode="a4" showPrintButton={false} innerRef={directorContractRef} />
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

export default ContractManagement;
