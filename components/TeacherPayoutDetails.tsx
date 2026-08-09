import React, { useCallback, useEffect, useState } from 'react';
import {
    Banknote,
    Check,
    FileText,
    Landmark,
    Loader2,
    Pencil,
    ShieldCheck,
    Upload,
    X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

// Dados de recebimento + envio de nota fiscal, na MESMA tela do Financeiro.
// Antes o professor tinha que sair para "Meu Perfil" (dados bancários) e para
// "Minhas Notas Fiscais" (NF) — três telas para fechar o mês. Aqui os dois ficam
// ao lado do resumo de aulas.

const PIX_TYPES = [
    { value: 'CPF', label: 'CPF' },
    { value: 'CNPJ', label: 'CNPJ' },
    { value: 'EMAIL', label: 'E-mail' },
    { value: 'PHONE', label: 'Telefone' },
    { value: 'EVP', label: 'Chave aleatória' },
];

interface BankForm {
    bankName: string;
    agency: string;
    accountNumber: string;
    pixKey: string;
    pixKeyType: string;
}

const EMPTY: BankForm = { bankName: '', agency: '', accountNumber: '', pixKey: '', pixKeyType: 'CPF' };

interface Props {
    teacherId: string;
    teacherName?: string;
    /** Mês YYYY-MM em foco — define de qual fechamento é a NF. */
    month: string;
    /** false quando é o diretor olhando a ficha de outro professor (só leitura). */
    canEdit: boolean;
    onChanged?: () => void;
}

const Field: React.FC<{ label: string; value?: string | null }> = ({ label, value }) => (
    <div className="rounded-2xl border border-brand-border bg-brand-surface-2/50 p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{label}</p>
        <p className="mt-1 break-words text-sm font-bold text-brand-text">{value?.trim() || '—'}</p>
    </div>
);

const TeacherPayoutDetails: React.FC<Props> = ({ teacherId, teacherName, month, canEdit, onChanged }) => {
    const [form, setForm] = useState<BankForm>(EMPTY);
    const [draft, setDraft] = useState<BankForm>(EMPTY);
    const [editing, setEditing] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [closing, setClosing] = useState<any>(null);
    const [uploading, setUploading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { data: profile } = await supabase
                .from('profiles')
                .select('bank_name, agency, account_number, full_name')
                .eq('id', teacherId)
                .maybeSingle();

            // pix_key não é legível direto em profiles (privacidade): vem por RPC.
            // O próprio professor usa get_my_pay; o diretor lê a lista do tenant.
            let pixKey = '';
            let pixKeyType = 'CPF';
            if (canEdit) {
                const { data: myPay } = await supabase.rpc('get_my_pay');
                pixKey = (myPay as any)?.pix_key || '';
                pixKeyType = (myPay as any)?.pix_key_type || 'CPF';
            } else {
                const { data: tenantPay } = await supabase.rpc('get_tenant_teacher_pay');
                const row = (tenantPay as any[])?.find((t) => t.id === teacherId);
                pixKey = row?.pix_key || '';
                pixKeyType = row?.pix_key_type || 'CPF';
            }

            const next: BankForm = {
                bankName: profile?.bank_name || '',
                agency: profile?.agency || '',
                accountNumber: profile?.account_number || '',
                pixKey,
                pixKeyType,
            };
            setForm(next);
            setDraft(next);

            const { data: closingData } = await supabase
                .from('teacher_closings')
                .select('id, status, nf_link, total_amount, total_lessons')
                .eq('teacher_id', teacherId)
                .eq('month_year', month)
                .maybeSingle();
            setClosing(closingData || null);
        } catch (err: any) {
            setError(err.message || 'Não foi possível carregar os dados de recebimento.');
        } finally {
            setLoading(false);
        }
    }, [teacherId, month, canEdit]);

    useEffect(() => { load(); }, [load]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const { error: updateError } = await supabase
                .from('profiles')
                .update({
                    bank_name: draft.bankName || null,
                    agency: draft.agency || null,
                    account_number: draft.accountNumber || null,
                    pix_key: draft.pixKey || null,
                    pix_key_type: draft.pixKeyType || null,
                    // ⚠️ `profiles` NÃO tem `updated_at` — ver TeacherPixSettings.
                    // A alteração fica registrada em `profile_audit_log`.
                })
                .eq('id', teacherId);
            if (updateError) throw updateError;
            setForm(draft);
            setEditing(false);
            onChanged?.();
        } catch (err: any) {
            setError('Erro ao salvar: ' + (err.message || 'tente novamente.'));
        } finally {
            setSaving(false);
        }
    };

    const handleUpload = async (file: File) => {
        if (!closing?.id) {
            setError('O fechamento deste mês ainda não foi gerado — a NF pode ser enviada depois que ele existir.');
            return;
        }
        if (file.type !== 'application/pdf') {
            setError('Envie a nota fiscal em PDF.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setError('Arquivo muito grande (limite de 5MB).');
            return;
        }
        setUploading(true);
        setError(null);
        try {
            const { data: { user: authUser } } = await supabase.auth.getUser();
            const cleanUserId = (authUser?.id || teacherId).replace(/[^a-zA-Z0-9]/g, '');
            const filePath = `user_${cleanUserId}/${Date.now()}_${file.name}`;

            const { error: uploadError } = await supabase.storage
                .from('invoices')
                .upload(filePath, file, { upsert: true });
            if (uploadError) {
                throw uploadError.message === 'Bucket not found'
                    ? new Error('Bucket "invoices" não encontrado. Contate o suporte.')
                    : uploadError;
            }

            // Bucket privado: getPublicUrl daria 403 pro diretor. Signed URL longa.
            const { data: signed } = await supabase.storage
                .from('invoices')
                .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 5);

            // Via RPC: o professor não escreve direto em teacher_closings (o mesmo
            // PATCH alcançaria total_amount/status). Ver teacher_attach_invoice.
            const { error: updateError } = await supabase.rpc('teacher_attach_invoice', {
                p_closing_id: closing.id,
                p_nf_link: signed?.signedUrl || filePath,
            });
            if (updateError) throw updateError;

            await load();
            onChanged?.();
        } catch (err: any) {
            setError('Erro no envio: ' + (err.message || 'tente novamente.'));
        } finally {
            setUploading(false);
        }
    };

    const hasBankData = Boolean(form.bankName || form.accountNumber || form.pixKey);

    const nfBadge = () => {
        const status = closing?.status || '';
        if (status === 'COMPLETED') return { label: 'Aprovada', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
        if (status === 'UNDER_REVIEW') return { label: 'Em análise', cls: 'bg-purple-100 text-purple-700 border-purple-200' };
        if (status === 'REJECTED') return { label: 'Rejeitada', cls: 'bg-red-100 text-red-700 border-red-200' };
        if (status === 'PAID_WAITING_NF') return { label: 'Envie sua NF', cls: 'bg-blue-100 text-blue-700 border-blue-200' };
        return { label: 'Pendente', cls: 'bg-brand-surface-2 text-brand-muted border-brand-border' };
    };

    return (
        <div className="grid gap-6 lg:grid-cols-2">
            {/* Dados bancários */}
            <section className="overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-brand-border p-5 sm:p-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="shrink-0 rounded-xl bg-tenant-primary/10 p-2.5 text-tenant-primary">
                            <Landmark size={20} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-black uppercase tracking-widest text-brand-text">Dados bancários</h3>
                            <p className="truncate text-xs font-medium text-brand-muted">Onde você recebe o pagamento.</p>
                        </div>
                    </div>
                    {canEdit && !editing && (
                        <button
                            type="button"
                            onClick={() => { setDraft(form); setEditing(true); }}
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-text transition-colors hover:text-tenant-primary"
                        >
                            <Pencil size={13} /> Editar
                        </button>
                    )}
                </header>

                <div className="p-5 sm:p-6">
                    {loading ? (
                        <div className="flex justify-center py-10"><Loader2 className="animate-spin text-brand-muted" /></div>
                    ) : editing ? (
                        <div className="space-y-4">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className="block">
                                    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Banco</span>
                                    <input
                                        value={draft.bankName}
                                        onChange={(e) => setDraft({ ...draft, bankName: e.target.value })}
                                        placeholder="Ex: Nubank"
                                        className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                    />
                                </label>
                                <label className="block">
                                    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Agência</span>
                                    <input
                                        value={draft.agency}
                                        onChange={(e) => setDraft({ ...draft, agency: e.target.value })}
                                        placeholder="0001"
                                        className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                    />
                                </label>
                                <label className="block sm:col-span-2">
                                    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Conta corrente</span>
                                    <input
                                        value={draft.accountNumber}
                                        onChange={(e) => setDraft({ ...draft, accountNumber: e.target.value })}
                                        placeholder="00000000-0"
                                        className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                    />
                                </label>
                                <label className="block">
                                    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Tipo de chave Pix</span>
                                    <select
                                        value={draft.pixKeyType}
                                        onChange={(e) => setDraft({ ...draft, pixKeyType: e.target.value })}
                                        className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                    >
                                        {PIX_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Chave Pix</span>
                                    <input
                                        value={draft.pixKey}
                                        onChange={(e) => setDraft({ ...draft, pixKey: e.target.value })}
                                        placeholder="Sua chave"
                                        className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                    />
                                </label>
                            </div>
                            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                                <button
                                    type="button"
                                    onClick={() => { setDraft(form); setEditing(false); setError(null); }}
                                    disabled={saving}
                                    className="shrink-0 whitespace-nowrap rounded-xl px-5 py-3 text-xs font-bold uppercase tracking-widest text-brand-muted transition-colors hover:text-brand-text"
                                >
                                    Cancelar
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-tenant-primary px-6 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-tenant-primary/20 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
                                >
                                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                                    {saving ? 'Salvando…' : 'Salvar'}
                                </button>
                            </div>
                        </div>
                    ) : hasBankData ? (
                        <div className="space-y-4">
                            {/* Cartão-resumo, no espírito do print */}
                            <div className="relative overflow-hidden rounded-2xl bg-slate-900 p-5 text-white">
                                <div className="pointer-events-none absolute -mt-24 -mr-24 top-0 right-0 h-48 w-48 rounded-full bg-tenant-primary/20 blur-3xl" />
                                <div className="relative z-10 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Banco</p>
                                        <p className="mt-0.5 truncate text-lg font-black uppercase tracking-tight">{form.bankName || '—'}</p>
                                    </div>
                                    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-300">
                                        <ShieldCheck size={12} /> Cadastrado
                                    </span>
                                </div>
                                <div className="relative z-10 mt-5 grid grid-cols-2 gap-4">
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Titular</p>
                                        <p className="mt-0.5 truncate text-sm font-bold uppercase">{teacherName || '—'}</p>
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Agência</p>
                                        <p className="mt-0.5 truncate text-sm font-bold">{form.agency || '—'}</p>
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Conta</p>
                                        <p className="mt-0.5 truncate text-sm font-bold">{form.accountNumber || '—'}</p>
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Pix ({form.pixKeyType})</p>
                                        <p className="mt-0.5 truncate text-sm font-bold">{form.pixKey || '—'}</p>
                                    </div>
                                </div>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field label="Tipo de chave" value={form.pixKeyType} />
                                <Field label="Chave Pix" value={form.pixKey} />
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-3 py-10 text-center">
                            <Banknote size={40} className="text-brand-muted opacity-30" />
                            <p className="text-sm font-bold text-brand-text">Nenhum dado bancário cadastrado</p>
                            <p className="max-w-xs text-xs font-medium text-brand-muted">
                                {canEdit
                                    ? 'Cadastre para a escola conseguir te pagar.'
                                    : 'O professor ainda não cadastrou os dados de recebimento.'}
                            </p>
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={() => { setDraft(EMPTY); setEditing(true); }}
                                    className="mt-1 shrink-0 whitespace-nowrap rounded-xl bg-tenant-primary px-6 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-tenant-primary/20"
                                >
                                    Cadastrar agora
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </section>

            {/* Nota fiscal do mês */}
            <section className="overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-brand-border p-5 sm:p-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="shrink-0 rounded-xl bg-tenant-primary/10 p-2.5 text-tenant-primary">
                            <FileText size={20} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-black uppercase tracking-widest text-brand-text">Nota fiscal</h3>
                            <p className="truncate text-xs font-medium text-brand-muted">Referente ao mês selecionado.</p>
                        </div>
                    </div>
                    <span className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${nfBadge().cls}`}>
                        {nfBadge().label}
                    </span>
                </header>

                <div className="space-y-4 p-5 sm:p-6">
                    {!closing ? (
                        <div className="flex flex-col items-center gap-2 py-10 text-center">
                            <FileText size={40} className="text-brand-muted opacity-30" />
                            <p className="text-sm font-bold text-brand-text">Fechamento ainda não gerado</p>
                            <p className="max-w-xs text-xs font-medium text-brand-muted">
                                A NF deste mês pode ser enviada assim que o fechamento existir.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-2xl border border-brand-border bg-brand-surface-2/50 p-4">
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Valor do fechamento</span>
                                    <span className="text-xl font-black tracking-tight text-brand-text">
                                        R$ {Number(closing.total_amount || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </span>
                                </div>
                                <p className="mt-1 text-xs font-medium text-brand-muted">{closing.total_lessons || 0} aulas</p>
                            </div>

                            {closing.nf_link && (
                                <a
                                    href={closing.nf_link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-brand-text transition-colors hover:text-tenant-primary"
                                >
                                    <FileText size={14} /> Ver nota enviada
                                </a>
                            )}

                            {canEdit && (
                                <div className="relative">
                                    <input
                                        type="file"
                                        accept="application/pdf"
                                        aria-label="Enviar nota fiscal em PDF"
                                        disabled={uploading}
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleUpload(file);
                                            e.target.value = '';
                                        }}
                                        className="absolute inset-0 z-10 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                                    />
                                    <button
                                        type="button"
                                        disabled={uploading}
                                        className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-tenant-primary px-4 py-3.5 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-tenant-primary/20 disabled:opacity-50"
                                    >
                                        {uploading
                                            ? <><Loader2 size={15} className="animate-spin" /> Enviando…</>
                                            : <><Upload size={15} /> {closing.nf_link ? 'Reenviar nota (PDF)' : 'Enviar nota fiscal (PDF)'}</>}
                                    </button>
                                </div>
                            )}

                            <p className="text-[11px] font-medium leading-relaxed text-brand-muted">
                                Só PDF, até 5MB. Depois de enviada, a nota entra em análise da coordenação.
                            </p>
                        </>
                    )}
                </div>
            </section>

            {error && (
                <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700 lg:col-span-2">
                    <X size={16} className="mt-0.5 shrink-0" />
                    <p className="text-sm font-medium">{error}</p>
                </div>
            )}
        </div>
    );
};

export default TeacherPayoutDetails;
