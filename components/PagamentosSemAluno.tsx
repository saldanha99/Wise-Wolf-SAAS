import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Link2, RefreshCw, AlertTriangle } from 'lucide-react';

/**
 * Pagamentos que entraram sem aluno vinculado.
 *
 * Não há matcher automático de propósito. Na investigação de julho/2026, dos 8
 * órfãos, seis eram da própria contratante (não são mensalidade), um era da mãe
 * de uma aluna e um provavelmente duplicava um recebimento em dinheiro já
 * lançado. Nenhuma regra acerta isso — só quem conhece o caixa. O que dá para
 * automatizar é o ALERTA de duplicata, e é o que a coluna do meio faz.
 */

interface Pagamento {
  id: string;
  value: number;
  status: string;
  due_date: string | null;
  pago_em: string | null;
  billing_type: string | null;
  asaas: string | null;
  descricao: string | null;
  mesmo_valor_ja_lancado: number;
}

interface Aluno { id: string; nome: string; }

interface Payload { month: string; pagamentos: Pagamento[]; alunos: Aluno[]; error?: string; }

const money = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const data = (s: string | null) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('pt-BR') : '—');

interface Props { month: string; onChanged: () => void; }

const PagamentosSemAluno: React.FC<Props> = ({ month, onChanged }) => {
  const [d, setD] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: r } = await supabase.rpc('list_unlinked_payments', { p_month: month });
    setD(r && !r.error ? (r as Payload) : null);
    setLoading(false);
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const vincular = async (p: Pagamento, studentId: string) => {
    if (!studentId) return;
    const aluno = d?.alunos.find(a => a.id === studentId);
    if (p.mesmo_valor_ja_lancado > 0) {
      const ok = window.confirm(
        `Atenção: já existem ${p.mesmo_valor_ja_lancado} pagamento(s) de ${money(p.value)} lançados neste mês.\n\n` +
        `Se este for o mesmo dinheiro registrado duas vezes, vincular vai contar a receita em dobro.\n\n` +
        `Vincular mesmo assim a ${aluno?.nome}?`,
      );
      if (!ok) return;
    }
    setSalvando(p.id); setErro(null);
    const { data: r } = await supabase.rpc('link_payment_to_student', {
      p_payment_id: p.id, p_student_id: studentId,
    });
    setSalvando(null);
    if (r?.error) {
      setErro(r.error === 'aluno_invalido' ? 'Aluno inválido.' : `Não foi possível vincular (${r.error}).`);
      return;
    }
    await load();
    onChanged();
  };

  const pagamentos = d?.pagamentos || [];
  const total = pagamentos.reduce((s, p) => s + Number(p.value || 0), 0);

  if (!loading && pagamentos.length === 0) return null;

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <Link2 size={16} className="text-amber-500" />
        <h3 className="text-sm font-bold text-brand-text">Pagamentos sem aluno vinculado</h3>
        {pagamentos.length > 0 && (
          <span className="text-xs text-brand-muted">{pagamentos.length} · {money(total)}</span>
        )}
        <button
          onClick={() => void load()}
          className="ml-auto p-1.5 rounded-lg text-brand-muted hover:text-brand-text"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="text-[11px] text-brand-muted mb-4">
        Esse dinheiro entrou e está na receita do mês, mas não dá para saber de quem veio nem
        atribuir a professor. Vincular ao aluno traz o valor para o balancete — não muda a receita total.
      </p>

      {erro && (
        <div className="mb-3 text-xs font-bold text-red-600 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {erro}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-brand-muted"><RefreshCw size={18} className="animate-spin mx-auto" /></div>
      ) : (
        <div className="space-y-2">
          {pagamentos.map(p => (
            <div key={p.id} className="border border-brand-border rounded-xl px-3 py-2.5 bg-brand-surface-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-brand-text">{money(p.value)}</span>
                    <span className="text-[11px] text-brand-muted">
                      vence {data(p.due_date)}{p.billing_type ? ` · ${p.billing_type}` : ''}
                    </span>
                    {p.mesmo_valor_ja_lancado > 0 && (
                      <span className="flex items-center gap-1 text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/30">
                        <AlertTriangle size={9} /> {p.mesmo_valor_ja_lancado}× mesmo valor no mês
                      </span>
                    )}
                  </div>
                  {p.asaas && <p className="text-[10px] text-brand-muted truncate">{p.asaas}</p>}
                </div>
                <select
                  defaultValue=""
                  disabled={salvando === p.id}
                  onChange={e => void vincular(p, e.target.value)}
                  className="text-xs bg-brand-surface text-brand-text rounded-lg px-2 py-1.5 border border-brand-border max-w-[230px]"
                >
                  <option value="">{salvando === p.id ? 'Vinculando…' : 'Vincular ao aluno…'}</option>
                  {(d?.alunos || []).map(a => <option key={a.id} value={a.id}>{a.nome}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-brand-muted mt-4 leading-relaxed">
        ⚠️ Nem todo pagamento sem aluno é mensalidade. Dinheiro da própria escola entrando pela conta
        (aporte, reembolso, transferência) aparece aqui e <b>não deve ser vinculado a aluno nenhum</b> —
        vinculá-lo inventaria receita de aula que não existiu.
      </p>
    </div>
  );
};

export default PagamentosSemAluno;
