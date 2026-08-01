import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    Calendar,
    ChevronDown,
    ChevronRight,
    Download,
    Loader2,
    TrendingUp,
    Users,
    Wallet,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { localMonth } from '../lib/dateUtils';
import { User } from '../types';

// Custo x receita x margem do mês, quebrado por professor e por aluno.
// O custo vem da MESMA view que paga o professor (v_payable_class_logs), então
// o número aqui bate com o que o professor vê no Financeiro dele — era isso que
// faltava para o diretor conferir se um aluno dá lucro ou prejuízo.

interface MarginRow {
    teacher_id: string;
    teacher_name: string;
    student_id: string | null;
    student_name: string;
    aulas: number;
    custo: number;
    receita: number;
    margem: number;
}

const money = (v: number) => `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const Kpi: React.FC<{ label: string; value: string; hint?: string; tone?: 'default' | 'cost' | 'good' | 'bad' }> = ({ label, value, hint, tone = 'default' }) => (
    <div className="rounded-2xl border border-brand-border bg-brand-surface p-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{label}</p>
        <p className={`mt-2 text-2xl font-black tracking-tight ${tone === 'cost' ? 'text-amber-600'
            : tone === 'good' ? 'text-emerald-600'
                : tone === 'bad' ? 'text-red-600'
                    : 'text-brand-text'}`}>
            {value}
        </p>
        {hint && <p className="mt-1 text-[11px] font-medium text-brand-muted">{hint}</p>}
    </div>
);

const DirectorMarginPanel: React.FC<{ user: User; tenantId?: string }> = ({ user }) => {
    const [month, setMonth] = useState(localMonth());
    const [rows, setRows] = useState<MarginRow[]>([]);
    const [total, setTotal] = useState<{ aulas: number; custo: number; receita: number; margem: number } | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [openTeachers, setOpenTeachers] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { data, error: rpcError } = await supabase.rpc('director_teacher_margin', { p_month: month });
            if (rpcError) throw rpcError;
            setRows(((data as any)?.rows || []) as MarginRow[]);
            setTotal((data as any)?.total || null);
        } catch (err: any) {
            setError(err.message || 'Não foi possível carregar o painel.');
            setRows([]);
            setTotal(null);
        } finally {
            setLoading(false);
        }
    }, [month]);

    useEffect(() => { load(); }, [load]);

    // Agrupa por professor mantendo a ordem que o RPC já devolveu (nome).
    const byTeacher = useMemo(() => {
        const map = new Map<string, { name: string; rows: MarginRow[]; aulas: number; custo: number; receita: number; margem: number }>();
        rows.forEach((r) => {
            const entry = map.get(r.teacher_id) || { name: r.teacher_name, rows: [], aulas: 0, custo: 0, receita: 0, margem: 0 };
            entry.rows.push(r);
            entry.aulas += Number(r.aulas) || 0;
            entry.custo += Number(r.custo) || 0;
            entry.receita += Number(r.receita) || 0;
            entry.margem += Number(r.margem) || 0;
            map.set(r.teacher_id, entry);
        });
        return Array.from(map.entries());
    }, [rows]);

    const toggle = (id: string) => {
        setOpenTeachers((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const exportCsv = () => {
        const cell = (value: string | number) => {
            const text = String(value);
            const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
            return `"${safe.replace(/"/g, '""')}"`;
        };
        const csv = [
            ['Professor', 'Aluno', 'Aulas', 'Custo professor (R$)', 'Receita aluno (R$)', 'Margem (R$)'],
            ...rows.map((r) => [
                r.teacher_name, r.student_name, r.aulas,
                Number(r.custo).toFixed(2).replace('.', ','),
                Number(r.receita).toFixed(2).replace('.', ','),
                Number(r.margem).toFixed(2).replace('.', ','),
            ]),
        ].map((row) => row.map(cell).join(';')).join('\r\n');
        const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `custo-margem-${month}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col items-stretch justify-between gap-4 rounded-[2rem] border border-brand-border bg-brand-surface p-4 shadow-sm sm:flex-row sm:items-center sm:p-6">
                <div className="min-w-0">
                    <h2 className="text-2xl font-black tracking-tight text-brand-text">Custo e Margem</h2>
                    <p className="text-sm font-medium text-brand-muted">Quanto cada aluno rende e quanto custa de professor.</p>
                </div>
                <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                    <button
                        type="button"
                        onClick={exportCsv}
                        disabled={rows.length === 0}
                        className="flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-tenant-primary/10 px-3 py-2 text-xs font-bold text-tenant-primary disabled:opacity-40 sm:w-auto"
                    >
                        <Download size={14} /> Exportar CSV
                    </button>
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                        <Calendar size={18} className="shrink-0 text-brand-muted" aria-hidden="true" />
                        <input
                            type="month"
                            aria-label="Mês do relatório de custo e margem"
                            value={month}
                            onChange={(e) => setMonth(e.target.value)}
                            className="min-w-0 flex-1 rounded-xl border-none bg-brand-surface-2 px-4 py-2 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary sm:flex-none"
                        />
                    </div>
                </div>
            </div>

            {error && (
                <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
                    <AlertCircle size={18} className="mt-0.5 shrink-0" />
                    <p className="text-sm font-medium">{error}</p>
                </div>
            )}

            {total && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Kpi label="Receita do mês" value={money(total.receita)} hint="Mensalidades recebidas" tone="good" />
                    <Kpi label="Custo com professor" value={money(total.custo)} hint={`${total.aulas} aulas pagáveis`} tone="cost" />
                    <Kpi
                        label="Margem"
                        value={money(total.margem)}
                        hint={total.receita > 0 ? `${Math.round((total.margem / total.receita) * 100)}% da receita` : undefined}
                        tone={total.margem >= 0 ? 'good' : 'bad'}
                    />
                    <Kpi
                        label="Custo por aula"
                        value={total.aulas > 0 ? money(total.custo / total.aulas) : '—'}
                        hint="Média do mês"
                    />
                </div>
            )}

            {loading ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-[2rem] border border-brand-border bg-brand-surface py-20 text-brand-muted">
                    <Loader2 className="animate-spin" size={26} />
                    <p className="text-xs font-bold uppercase tracking-widest">Somando o mês…</p>
                </div>
            ) : byTeacher.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-[2rem] border border-brand-border bg-brand-surface py-20 text-center text-brand-muted">
                    <Users size={44} className="opacity-20" />
                    <p className="text-sm font-bold uppercase tracking-widest">Nenhuma aula paga neste mês.</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {byTeacher.map(([teacherId, t]) => {
                        const isOpen = openTeachers.has(teacherId);
                        return (
                            <section key={teacherId} className="overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-sm">
                                <button
                                    type="button"
                                    onClick={() => toggle(teacherId)}
                                    aria-expanded={isOpen}
                                    className="flex w-full items-center justify-between gap-4 p-5 text-left transition-colors hover:bg-brand-surface-2/50 sm:p-6"
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span className="shrink-0 text-brand-muted">
                                            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                        </span>
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-black uppercase tracking-tight text-brand-text">{t.name}</p>
                                            <p className="text-xs font-medium text-brand-muted">
                                                {t.rows.length} aluno(s) · {t.aulas} aulas
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-4 sm:gap-8">
                                        <div className="hidden text-right sm:block">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Custo</p>
                                            <p className="text-sm font-bold text-amber-600">{money(t.custo)}</p>
                                        </div>
                                        <div className="hidden text-right sm:block">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Receita</p>
                                            <p className="text-sm font-bold text-brand-text">{money(t.receita)}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Margem</p>
                                            <p className={`text-base font-black ${t.margem >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(t.margem)}</p>
                                        </div>
                                    </div>
                                </button>

                                {isOpen && (
                                    <div className="overflow-x-auto border-t border-brand-border">
                                        <table className="w-full min-w-[620px]">
                                            <thead>
                                                <tr className="bg-brand-surface-2/50">
                                                    <th className="px-6 py-3 text-left text-[10px] font-black uppercase tracking-widest text-brand-muted">Aluno</th>
                                                    <th className="px-6 py-3 text-center text-[10px] font-black uppercase tracking-widest text-brand-muted">Aulas</th>
                                                    <th className="px-6 py-3 text-right text-[10px] font-black uppercase tracking-widest text-brand-muted">Custo prof.</th>
                                                    <th className="px-6 py-3 text-right text-[10px] font-black uppercase tracking-widest text-brand-muted">Receita</th>
                                                    <th className="px-6 py-3 text-right text-[10px] font-black uppercase tracking-widest text-brand-muted">Margem</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-brand-border">
                                                {t.rows.map((r, i) => (
                                                    <tr key={`${r.student_id ?? 'sem'}-${i}`} className="hover:bg-brand-surface-2/40">
                                                        <td className="px-6 py-4 text-sm font-bold text-brand-text">{r.student_name}</td>
                                                        <td className="px-6 py-4 text-center text-sm font-bold text-brand-muted">{r.aulas}</td>
                                                        <td className="px-6 py-4 text-right text-sm font-bold text-amber-600">{money(r.custo)}</td>
                                                        <td className="px-6 py-4 text-right text-sm font-bold text-brand-text">
                                                            {Number(r.receita) > 0 ? money(r.receita) : <span className="text-brand-muted">sem pagamento</span>}
                                                        </td>
                                                        <td className={`px-6 py-4 text-right text-sm font-black ${Number(r.margem) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                            {money(r.margem)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}

            <p className="flex items-start gap-2 text-[11px] font-medium leading-relaxed text-brand-muted">
                <TrendingUp size={14} className="mt-0.5 shrink-0" />
                <span>
                    Receita = mensalidades <strong>recebidas</strong> no mês. Aluno que aparece com "sem pagamento" teve aula
                    mas nenhum pagamento baixado no período — pode ser inadimplência ou pagamento adiantado em outro mês.
                    O custo é o mesmo número que o professor vê no Financeiro dele.
                </span>
            </p>
        </div>
    );
};

export default DirectorMarginPanel;
