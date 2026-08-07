import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
    AlertTriangle, ArrowUpRight, CheckCircle2, FileWarning, Loader2,
    RefreshCw, UserMinus, UserX, Wallet,
} from 'lucide-react';
import { User } from '../types';

// Reconciliação financeira — estados que ninguém vigia.
//
// Não é mais um relatório de números: é a lista do que está PARADO. Cada bloco
// existe porque o dinheiro correspondente não aparecia em painel nenhum — nem
// em inadimplência, nem no DRE, nem no fluxo de caixa.
//
// A tela REPORTA e leva à tela de ação. Ela não emite cobrança nem cancela
// contrato: isso é decisão comercial, e um botão que cobra sozinho criaria
// fatura para aluno que talvez tenha um acordo verbal com a direção.

interface FinancialReconciliationProps {
    user: User;
    tenantId?: string;
    /** Navega para a tela onde a pendência é resolvida. */
    onNavigate?: (tab: string) => void;
}

const brl = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface BlocoProps {
    icone: React.ReactNode;
    titulo: string;
    porque: string;
    qtd: number;
    valor?: number;
    valorRotulo?: string;
    tom: 'critico' | 'atencao' | 'neutro';
    acao?: { label: string; tab: string };
    onNavigate?: (tab: string) => void;
    children: React.ReactNode;
}

const TONS = {
    critico: 'border-red-500/40 bg-red-500/5',
    atencao: 'border-amber-500/40 bg-amber-500/5',
    neutro: 'border-brand-border bg-brand-surface-2/40',
};

const Bloco: React.FC<BlocoProps> = ({
    icone, titulo, porque, qtd, valor, valorRotulo, tom, acao, onNavigate, children,
}) => {
    if (qtd === 0) return null;
    return (
        <section className={`rounded-3xl border p-5 sm:p-6 ${TONS[tom]}`}>
            <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-sm font-black tracking-tight text-brand-text">
                        {icone} {titulo}
                        <span className="rounded-full bg-brand-surface px-2.5 py-0.5 text-[10px] font-black text-brand-muted">
                            {qtd}
                        </span>
                    </h3>
                    <p className="mt-1 text-xs text-brand-muted">{porque}</p>
                </div>
                {valor !== undefined && valor > 0 && (
                    <div className="text-right">
                        <p className="text-lg font-black tracking-tight text-brand-text">{brl(valor)}</p>
                        {valorRotulo && (
                            <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted">{valorRotulo}</p>
                        )}
                    </div>
                )}
            </header>

            <div className="overflow-x-auto">{children}</div>

            {acao && onNavigate && (
                <button
                    type="button"
                    onClick={() => onNavigate(acao.tab)}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-brand-border bg-brand-surface px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted transition-all hover:text-brand-text"
                >
                    {acao.label} <ArrowUpRight size={13} />
                </button>
            )}
        </section>
    );
};

const Tabela: React.FC<{ colunas: string[]; linhas: (string | number)[][] }> = ({ colunas, linhas }) => (
    <table className="w-full min-w-[520px] text-left text-xs">
        <thead>
            <tr className="border-b border-brand-border">
                {colunas.map(c => (
                    <th key={c} className="pb-2 text-[9px] font-black uppercase tracking-widest text-brand-muted">{c}</th>
                ))}
            </tr>
        </thead>
        <tbody>
            {linhas.map((l, i) => (
                <tr key={i} className="border-b border-brand-border/50 last:border-0">
                    {l.map((celula, j) => (
                        <td key={j} className={`py-2.5 ${j === 0 ? 'font-bold text-brand-text' : 'text-brand-muted'}`}>
                            {celula}
                        </td>
                    ))}
                </tr>
            ))}
        </tbody>
    </table>
);

const FinancialReconciliation: React.FC<FinancialReconciliationProps> = ({ tenantId, onNavigate }) => {
    const [dados, setDados] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [erro, setErro] = useState('');

    const carregar = async () => {
        setLoading(true);
        setErro('');
        const { data, error } = await supabase.rpc('financial_reconciliation', { p_tenant: tenantId ?? null });
        if (error) setErro(error.message);
        else if (data?.error) setErro(data.error === 'sem_permissao' ? 'Sem permissão.' : String(data.error));
        else setDados(data);
        setLoading(false);
    };

    useEffect(() => { carregar(); }, [tenantId]);

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-10 text-brand-muted">
                <Loader2 size={16} className="animate-spin" /> Reconciliando…
            </div>
        );
    }

    if (erro) {
        return <div className="p-8 text-sm font-bold text-red-500">{erro}</div>;
    }

    const b = (k: string) => dados?.[k] || { itens: [], qtd: 0, total: 0 };
    const semCobertura = b('sem_cobertura');
    const semEstudar = b('cobrado_sem_estudar');
    const arquivado = b('arquivado_com_fatura');
    const semNf = b('pago_sem_nf');
    const paradoNf = b('parado_com_nf');
    const naoLancada = b('aula_nao_lancada');

    const totalPendencias = [semCobertura, semEstudar, arquivado, semNf, paradoNf, naoLancada]
        .reduce((s, x) => s + (x.qtd || 0), 0);

    return (
        <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-black tracking-tight text-brand-text sm:text-3xl">Reconciliação Financeira</h1>
                    <p className="mt-1 text-sm font-medium text-brand-muted">
                        Dinheiro parado em estados que não aparecem em inadimplência, DRE nem fluxo de caixa.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={carregar}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-brand-border bg-brand-surface-2 px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted hover:text-brand-text"
                >
                    <RefreshCw size={13} /> Recalcular
                </button>
            </header>

            {totalPendencias === 0 ? (
                <div className="flex items-center gap-3 rounded-3xl border border-emerald-500/40 bg-emerald-500/5 p-6">
                    <CheckCircle2 size={20} className="text-emerald-500" />
                    <p className="text-sm font-bold text-brand-text">Nenhuma pendência de reconciliação. Tudo conferido.</p>
                </div>
            ) : (
                <>
                    <Bloco
                        icone={<Wallet size={15} className="text-red-500" />}
                        titulo="Aula entregue além do que foi pago"
                        porque="Meses de aula dados menos meses pagos. Quem pagou o ano à vista não aparece aqui — a conta é dinheiro recebido, não número de boletos."
                        qtd={semCobertura.qtd}
                        valor={Number(semCobertura.total || 0)}
                        valorRotulo="estimado"
                        tom="critico"
                        acao={{ label: 'Ir para Mensalidades', tab: 'student-payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Mensalidade', 'Meses de aula', 'Meses pagos', 'Déficit', 'Recebido', 'Estimado']}
                            linhas={(semCobertura.itens || []).map((i: any) => [
                                i.aluno, brl(i.mensalidade), i.meses_servico, i.meses_pagos,
                                `${i.deficit_meses} ${Number(i.deficit_meses) === 1 ? 'mês' : 'meses'}`,
                                brl(i.total_recebido), brl(i.valor_estimado),
                            ])}
                        />
                        <p className="mt-3 text-[10px] text-brand-muted">
                            "Estimado" é déficit × mensalidade atual — serve para dimensionar o buraco, não para emitir boleto.
                        </p>
                    </Bloco>

                    <Bloco
                        icone={<UserX size={15} className="text-amber-500" />}
                        titulo="Cobrado sem estudar"
                        porque="Fatura correndo para quem não tem agenda nem aula há 90 dias. Ou encerra, ou cobra de verdade."
                        qtd={semEstudar.qtd}
                        valor={Number(semEstudar.total || 0)}
                        valorRotulo="em aberto"
                        tom="atencao"
                        acao={{ label: 'Ir para Alunos', tab: 'students' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Faturas abertas', 'Em aberto']}
                            linhas={(semEstudar.itens || []).map((i: any) => [
                                i.aluno, i.faturas_abertas, brl(i.em_aberto),
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<UserMinus size={15} className="text-amber-500" />}
                        titulo="Arquivado com fatura em aberto"
                        porque="O aluno já foi arquivado, mas as faturas ficaram de pé — ninguém as cobra e mesmo assim elas inflam o total de inadimplência."
                        qtd={arquivado.qtd}
                        valor={Number(arquivado.total || 0)}
                        valorRotulo="a cancelar ou cobrar"
                        tom="atencao"
                        acao={{ label: 'Ir para Mensalidades', tab: 'student-payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Situação', 'Faturas abertas', 'Em aberto']}
                            linhas={(arquivado.itens || []).map((i: any) => [
                                i.aluno, i.status, i.faturas_abertas, brl(i.em_aberto),
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<FileWarning size={15} className="text-amber-500" />}
                        titulo="Pago sem nota fiscal"
                        porque="O repasse saiu e a nota não entrou há mais de 30 dias. Risco fiscal."
                        qtd={semNf.qtd}
                        valor={Number(semNf.total || 0)}
                        valorRotulo="sem NF"
                        tom="atencao"
                        acao={{ label: 'Ir para Notas Fiscais', tab: 'invoices' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Mês', 'Situação', 'Valor', 'Pago em']}
                            linhas={(semNf.itens || []).map((i: any) => [
                                i.professor, i.month_year, i.status, brl(i.valor), i.pago_em,
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<AlertTriangle size={15} className="text-amber-500" />}
                        titulo="Fechamento parado esperando aprovação"
                        porque="O professor anexou a nota há mais de 7 dias e ninguém aprovou. Cada dia aqui é um dia que ele não recebe."
                        qtd={paradoNf.qtd}
                        valor={Number(paradoNf.total || 0)}
                        valorRotulo="a aprovar"
                        tom="critico"
                        acao={{ label: 'Ir para Repasse a profs', tab: 'payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Mês', 'Valor', 'Dias parado']}
                            linhas={(paradoNf.itens || []).map((i: any) => [
                                i.professor, i.month_year, brl(i.valor), i.dias_parado,
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<AlertTriangle size={15} className="text-amber-500" />}
                        titulo="Aula confirmada e nunca lançada"
                        porque="O aluno confirmou que a aula aconteceu e não existe lançamento. O professor não vai receber por ela."
                        qtd={naoLancada.qtd}
                        tom="atencao"
                        acao={{ label: 'Ir para Verificar Presença', tab: 'attendance-disputes' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Aluno', 'Data', 'Dias']}
                            linhas={(naoLancada.itens || []).map((i: any) => [
                                i.professor, i.aluno, i.data, i.dias,
                            ])}
                        />
                    </Bloco>
                </>
            )}

            <p className="pb-4 text-[10px] text-brand-muted">
                Esta tela não emite cobrança nem cancela contrato — ela mostra e leva à tela onde a decisão é tomada.
            </p>
        </div>
    );
};

export default FinancialReconciliation;
