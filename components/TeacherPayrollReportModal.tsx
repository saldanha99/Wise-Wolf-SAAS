import React, { useState, useEffect, useCallback } from 'react';
import { X, Printer, Loader2, ChevronDown, ChevronRight, GraduationCap, AlertCircle, Pencil, Check, RotateCcw } from 'lucide-react';
import { supabase } from '../lib/supabase';

// Relatório unificado de pagamento por professor — mesmo formato da folha manual da
// escola: uma linha por aluno (frequência, total de aulas, valor), experimentais
// destacadas, resumo do mês e rodapé com o que ficou de fora (falta do professor,
// conflitos de antifraude, treinamentos). Fonte: RPC get_teacher_closing_report.

interface ReportStudentRow {
    student: string;
    tipo: 'Regular' | 'Aula experimental';
    frequencia: string;
    aulas: number;
    faltas_aluno: number;
    valor: number;
    detalhe: { id: string; date: string; presence: string; subtype: string | null; valor: number; override: boolean }[];
}

interface PayrollReport {
    teacher: { id: string; name: string; avatar_url: string | null };
    month: string;
    closing: {
        id: string; status: string; total_lessons: number;
        total_amount: number; paid_at: string | null; admin_notes: string | null;
    } | null;
    students: ReportStudentRow[];
    resumo: {
        total_alunos: number; aulas_regulares: number;
        aulas_experimentais: number; total_aulas: number; valor_total: number;
    };
    excluidas: {
        falta_professor: number; em_conflito: number;
        teste_oral: number; nao_faturavel: number;
    };
}

interface TeacherPayrollReportModalProps {
    teacherId: string;
    month: string; // YYYY-MM
    onClose: () => void;
}

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[(m || 1) - 1]} de ${y}`;
};

const money = (v: number) =>
    `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const presenceLabel = (p: string, subtype: string | null) => {
    let base: string;
    switch (p) {
        case 'COMPLETED': base = 'Presença'; break;
        case 'STUDENT_ABSENCE': base = 'Falta do aluno'; break;
        case 'Falta Justificada': base = 'Falta justificada'; break;
        default: base = p;
    }
    if (subtype === 'REPOSIÇÃO' || subtype === 'REPOSIÇÃO_PROF') return `${base} (reposição)`;
    if (subtype === 'AULA EXPERIMENTAL') return `${base} (experimental)`;
    return base;
};

const TeacherPayrollReportModal: React.FC<TeacherPayrollReportModalProps> = ({ teacherId, month, onClose }) => {
    const [report, setReport] = useState<PayrollReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    // Edição manual do valor de UM lançamento (ponto 2): id da aula em edição + rascunho.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftValue, setDraftValue] = useState('');
    const [savingId, setSavingId] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setLoading(true);
        try {
            const { data, error: rpcError } = await supabase.rpc('get_teacher_closing_report', {
                p_teacher_id: teacherId,
                p_month: month
            });
            if (rpcError) throw rpcError;
            setReport(data as PayrollReport);
        } catch (err: any) {
            console.error('Error fetching payroll report:', err);
            setError(err.message || 'Erro ao carregar o relatório.');
        } finally {
            setLoading(false);
        }
    }, [teacherId, month]);

    useEffect(() => { fetchReport(); }, [fetchReport]);

    // Salva o valor manual (ou limpa, voltando ao cálculo automático quando p_value é null).
    const saveOverride = async (logId: string, rawValue: string | null) => {
        setSavingId(logId);
        try {
            let parsed: number | null = null;
            if (rawValue !== null) {
                parsed = Number(rawValue.replace(',', '.'));
                if (!isFinite(parsed) || parsed < 0) {
                    alert('Informe um valor válido (ex: 8 ou 8,50).');
                    setSavingId(null);
                    return;
                }
            }
            const { error: rpcError } = await supabase.rpc('set_class_log_rate_override', {
                p_log_id: logId,
                p_value: parsed
            });
            if (rpcError) throw rpcError;
            setEditingId(null);
            setDraftValue('');
            await fetchReport();
        } catch (err: any) {
            alert('Erro ao salvar o valor: ' + (err.message || 'tente novamente.'));
        } finally {
            setSavingId(null);
        }
    };

    const toggleRow = (idx: number) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    };

    const excludedNotes: string[] = [];
    if (report?.excluidas) {
        const ex = report.excluidas;
        if (ex.falta_professor > 0) excludedNotes.push(`${ex.falta_professor} falta(s) do professor`);
        if (ex.em_conflito > 0) excludedNotes.push(`${ex.em_conflito} aula(s) em conflito (antifraude)`);
        if (ex.teste_oral > 0) excludedNotes.push(`${ex.teste_oral} teste(s) oral(is)`);
        if (ex.nao_faturavel > 0) excludedNotes.push(`${ex.nao_faturavel} treinamento(s)/registro(s) não remunerado(s)`);
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 print:p-0 print:bg-white">
            {/* Só o conteúdo do relatório sai na impressão */}
            <style>{`
                @media print {
                    body * { visibility: hidden; }
                    #payroll-report-print, #payroll-report-print * { visibility: visible; }
                    #payroll-report-print { position: absolute; inset: 0; max-height: none !important; overflow: visible !important; border-radius: 0 !important; box-shadow: none !important; }
                    .print-hidden { display: none !important; }
                }
            `}</style>

            <div id="payroll-report-print" className="bg-brand-surface dark:bg-brand-surface-2 w-full max-w-3xl max-h-[90dvh] rounded-[2rem] shadow-2xl border border-brand-border flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-start justify-between gap-4 p-6 md:p-8 border-b border-brand-border shrink-0">
                    <div className="flex items-center gap-4 min-w-0">
                        <div className="p-3 bg-tenant-primary/10 rounded-2xl text-tenant-primary shrink-0">
                            <GraduationCap size={24} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest">Relatório de Pagamento</p>
                            <h2 className="text-xl md:text-2xl font-black text-brand-text tracking-tight truncate">
                                {report?.teacher?.name ? `Teacher ${report.teacher.name.trim().split(' ')[0]}` : 'Carregando…'}
                            </h2>
                            <p className="text-xs font-bold text-brand-muted">{monthLabel(month)}{report?.teacher?.name ? ` · ${report.teacher.name.trim()}` : ''}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 print-hidden shrink-0">
                        <button
                            onClick={() => window.print()}
                            className="p-2.5 text-brand-muted hover:text-tenant-primary hover:bg-tenant-primary/10 rounded-xl transition-colors"
                            title="Imprimir / salvar em PDF"
                        >
                            <Printer size={20} />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2.5 text-brand-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                            title="Fechar"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-16 text-brand-muted">
                            <Loader2 className="animate-spin mb-3" size={28} />
                            <p className="text-xs font-bold uppercase tracking-widest">Montando relatório…</p>
                        </div>
                    ) : error ? (
                        <div className="flex items-center gap-3 p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700">
                            <AlertCircle size={18} className="shrink-0" />
                            <p className="text-sm font-medium">{error}</p>
                        </div>
                    ) : report ? (
                        <>
                            {/* Tabela por aluno — mesmo formato da folha manual */}
                            <div className="rounded-2xl border border-brand-border overflow-hidden">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm min-w-[480px]">
                                        <thead>
                                            <tr className="bg-brand-surface-2/60 text-[10px] font-black text-brand-muted uppercase tracking-widest">
                                                <th className="text-left px-4 py-3">Aluno</th>
                                                <th className="text-left px-4 py-3">Frequência</th>
                                                <th className="text-center px-4 py-3">Total de aulas</th>
                                                <th className="text-right px-4 py-3">Valor</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-brand-border">
                                            {report.students.map((row, idx) => (
                                                <React.Fragment key={`${row.student}-${row.tipo}-${idx}`}>
                                                    <tr
                                                        onClick={() => toggleRow(idx)}
                                                        className="cursor-pointer hover:bg-brand-surface-2/50 transition-colors"
                                                        title="Ver as datas das aulas"
                                                    >
                                                        <td className="px-4 py-3 font-bold text-brand-text">
                                                            <span className="flex items-center gap-2">
                                                                <span className="print-hidden text-brand-muted">
                                                                    {expanded.has(idx) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                                </span>
                                                                {row.student}
                                                            </span>
                                                        </td>
                                                        <td className="px-4 py-3 text-brand-muted font-medium">
                                                            {row.tipo === 'Aula experimental' ? (
                                                                <span className="text-[10px] font-black uppercase tracking-widest bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full border border-purple-200">Aula experimental</span>
                                                            ) : row.frequencia}
                                                        </td>
                                                        <td className="px-4 py-3 text-center font-bold text-brand-text">{row.aulas}</td>
                                                        <td className="px-4 py-3 text-right font-black text-brand-text">{money(row.valor)}</td>
                                                    </tr>
                                                    {expanded.has(idx) && (
                                                        <tr className="bg-brand-surface-2/40">
                                                            <td colSpan={4} className="px-6 pb-4 pt-2">
                                                                <div className="flex flex-col gap-1.5">
                                                                    {row.detalhe.map((d, i) => {
                                                                        const isEditing = editingId === d.id;
                                                                        const isSaving = savingId === d.id;
                                                                        return (
                                                                            <div key={d.id || i} className={`flex items-center justify-between gap-3 text-[11px] font-bold px-3 py-2 rounded-lg border ${d.presence === 'COMPLETED'
                                                                                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                                                                : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
                                                                                <span>
                                                                                    {new Date(`${d.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · {presenceLabel(d.presence, d.subtype)}
                                                                                </span>
                                                                                {isEditing ? (
                                                                                    <span className="flex items-center gap-1.5 print-hidden">
                                                                                        <span className="text-brand-muted">R$</span>
                                                                                        <input
                                                                                            type="text"
                                                                                            inputMode="decimal"
                                                                                            autoFocus
                                                                                            value={draftValue}
                                                                                            onChange={e => setDraftValue(e.target.value)}
                                                                                            onKeyDown={e => { if (e.key === 'Enter') saveOverride(d.id, draftValue); if (e.key === 'Escape') setEditingId(null); }}
                                                                                            className="w-20 px-2 py-1 rounded-md border border-brand-border bg-brand-surface text-brand-text text-right outline-none focus:ring-2 focus:ring-tenant-primary"
                                                                                            placeholder="0,00"
                                                                                        />
                                                                                        <button onClick={() => saveOverride(d.id, draftValue)} disabled={isSaving} title="Salvar valor" className="p-1 rounded-md text-emerald-600 hover:bg-emerald-100 disabled:opacity-50">
                                                                                            {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                                                                        </button>
                                                                                        {d.override && (
                                                                                            <button onClick={() => saveOverride(d.id, null)} disabled={isSaving} title="Voltar ao valor automático" className="p-1 rounded-md text-brand-muted hover:bg-brand-surface-2">
                                                                                                <RotateCcw size={13} />
                                                                                            </button>
                                                                                        )}
                                                                                        <button onClick={() => setEditingId(null)} disabled={isSaving} title="Cancelar" className="p-1 rounded-md text-brand-muted hover:bg-brand-surface-2">
                                                                                            <X size={13} />
                                                                                        </button>
                                                                                    </span>
                                                                                ) : (
                                                                                    <span className="flex items-center gap-2">
                                                                                        <span className={d.override ? 'text-tenant-primary' : ''} title={d.override ? 'Valor ajustado manualmente' : undefined}>
                                                                                            {money(d.valor)}{d.override ? ' ✎' : ''}
                                                                                        </span>
                                                                                        <button
                                                                                            onClick={() => { setEditingId(d.id); setDraftValue(String(d.valor ?? '').replace('.', ',')); }}
                                                                                            title="Editar valor deste lançamento"
                                                                                            className="print-hidden p-1 rounded-md text-brand-muted hover:text-tenant-primary hover:bg-tenant-primary/10"
                                                                                        >
                                                                                            <Pencil size={12} />
                                                                                        </button>
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            ))}
                                            {report.students.length === 0 && (
                                                <tr>
                                                    <td colSpan={4} className="px-4 py-8 text-center text-brand-muted font-medium">
                                                        Nenhuma aula remunerada lançada neste mês.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* Resumo */}
                            <div className="rounded-2xl border border-brand-border bg-brand-surface-2/40 p-5 md:p-6">
                                <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest mb-4">Resumo</p>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    <div>
                                        <p className="text-2xl font-black text-brand-text">{report.resumo.total_alunos}</p>
                                        <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">Alunos</p>
                                    </div>
                                    <div>
                                        <p className="text-2xl font-black text-brand-text">{report.resumo.aulas_regulares}</p>
                                        <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">Aulas regulares</p>
                                    </div>
                                    <div>
                                        <p className="text-2xl font-black text-brand-text">{report.resumo.aulas_experimentais}</p>
                                        <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">Experimentais</p>
                                    </div>
                                    <div>
                                        <p className="text-2xl font-black text-brand-text">{report.resumo.total_aulas}</p>
                                        <p className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">Total de aulas</p>
                                    </div>
                                </div>
                                <div className="mt-5 pt-5 border-t border-brand-border flex items-center justify-between">
                                    <p className="text-xs font-black text-brand-muted uppercase tracking-widest">Valor total</p>
                                    <p className="text-3xl font-black text-tenant-primary tracking-tight">{money(report.resumo.valor_total)}</p>
                                </div>
                            </div>

                            {/* Divergência fechamento × relatório (se o fechamento estiver congelado com outro valor) */}
                            {report.closing && Number(report.closing.total_amount) !== Number(report.resumo.valor_total) && (
                                <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200">
                                    <AlertCircle size={18} className="text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-xs text-amber-800 font-medium leading-relaxed">
                                        O fechamento registrado deste mês está em <strong>{money(Number(report.closing.total_amount))}</strong> ({report.closing.total_lessons} aulas),
                                        diferente do recalculado acima — provavelmente houve correção de lançamentos depois do fechamento.
                                    </p>
                                </div>
                            )}

                            {/* O que ficou de fora da folha */}
                            {excludedNotes.length > 0 && (
                                <p className="text-[11px] text-brand-muted font-medium leading-relaxed">
                                    Não remuneradas neste mês: {excludedNotes.join(' · ')}.
                                </p>
                            )}
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
};

export default TeacherPayrollReportModal;
