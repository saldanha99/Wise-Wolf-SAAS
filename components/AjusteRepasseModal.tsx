import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { X, Plus, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';

/**
 * Lançamento manual no repasse do professor.
 *
 * Existe porque acordos fora da conta de aulas são rotina — reserva de agenda,
 * bônus, desconto — e até aqui só dava para gravá-los por SQL. O acordo de
 * R$ 30,00 com a Lais ficou dias invisível nas telas por causa disso.
 *
 * Valor NEGATIVO é permitido de propósito: desconto é tão comum quanto bônus, e
 * obrigar o diretor a "somar ao contrário" em outro lugar seria pior.
 *
 * O aviso de fechamento não-PENDENTE não é decorativo: a RPC só soma ao repasse
 * quando o fechamento ainda está aberto. Se já foi pago ou está em revisão, o
 * ajuste fica registrado mas NÃO entra sozinho — e quem lançou precisa saber
 * disso na hora, não no dia do pagamento.
 */

interface Ajuste {
  id: string;
  description: string;
  amount: number;
  created_at: string;
}

interface Props {
  teacherId: string;
  teacherName: string;
  month: string;
  /** Status do fechamento — só PENDENTE recebe o ajuste automaticamente. */
  closingStatus?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const money = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const AjusteRepasseModal: React.FC<Props> = ({
  teacherId, teacherName, month, closingStatus, onClose, onSaved,
}) => {
  const [itens, setItens] = useState<Ajuste[]>([]);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const abertoParaSoma = (closingStatus || '').toUpperCase() === 'PENDENTE';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.rpc('teacher_closing_adjustments', {
      p_teacher_id: teacherId, p_month: month,
    });
    setItens(Array.isArray(data) ? (data as Ajuste[]) : []);
    setLoading(false);
  }, [teacherId, month]);

  useEffect(() => { void load(); }, [load]);

  const salvar = async () => {
    const n = Number(valor.replace(/\./g, '').replace(',', '.'));
    if (!descricao.trim()) { setErro('Descreva o motivo — é o que aparece na folha do professor.'); return; }
    if (!Number.isFinite(n) || n === 0) { setErro('Informe um valor diferente de zero.'); return; }

    setSalvando(true); setErro(null);
    const { data, error } = await supabase.rpc('set_closing_adjustment', {
      p_teacher_id: teacherId, p_month: month,
      p_description: descricao.trim(), p_amount: n, p_delete_id: null,
    });
    setSalvando(false);
    if (error) { setErro(error.message || 'Não foi possível lançar.'); return; }
    if ((data as { aviso?: string })?.aviso) setErro((data as { aviso: string }).aviso);
    setDescricao(''); setValor('');
    await load();
    onSaved();
  };

  const remover = async (a: Ajuste) => {
    if (!window.confirm(`Remover "${a.description}" (${money(a.amount)})?`)) return;
    setSalvando(true); setErro(null);
    const { error } = await supabase.rpc('set_closing_adjustment', {
      p_teacher_id: teacherId, p_month: month,
      p_description: null, p_amount: null, p_delete_id: a.id,
    });
    setSalvando(false);
    if (error) { setErro(error.message || 'Não foi possível remover.'); return; }
    await load();
    onSaved();
  };

  const total = itens.reduce((s, a) => s + Number(a.amount || 0), 0);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-brand-surface border border-brand-border shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-brand-border">
          <div>
            <h3 className="text-base font-bold text-brand-text">Lançamento manual no repasse</h3>
            <p className="text-xs text-brand-muted">{teacherName} · {month}</p>
          </div>
          <button onClick={onClose} className="p-1.5 -m-1 rounded-lg text-brand-muted hover:text-brand-text">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!abertoParaSoma && (
            <div className="flex items-start gap-2 text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>
                O fechamento deste mês está <b>{closingStatus || 'sem status'}</b>, não PENDENTE.
                O lançamento fica registrado, mas <b>não entra sozinho</b> no valor a pagar —
                é preciso ajustar o fechamento à mão.
              </span>
            </div>
          )}

          {erro && (
            <div className="text-xs font-bold text-red-600 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              {erro}
            </div>
          )}

          <div className="grid sm:grid-cols-[1fr_140px] gap-2">
            <div>
              <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Motivo</label>
              <input
                value={descricao}
                onChange={e => setDescricao(e.target.value)}
                placeholder="Reserva de agenda — acordo com a direção"
                className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Valor (R$)</label>
              <input
                value={valor}
                onChange={e => setValor(e.target.value)}
                inputMode="decimal"
                placeholder="30,00"
                className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
              <span className="text-[10px] text-brand-muted">negativo desconta</span>
            </div>
          </div>

          <button
            onClick={() => void salvar()}
            disabled={salvando}
            className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            <Plus size={14} /> {salvando ? 'Lançando…' : 'Lançar'}
          </button>

          <div className="border-t border-brand-border pt-4">
            <p className="text-[10px] font-black uppercase text-brand-muted mb-2">
              Lançamentos do mês {itens.length > 0 && `· total ${money(total)}`}
            </p>
            {loading ? (
              <div className="py-4 text-center text-brand-muted"><RefreshCw size={16} className="animate-spin mx-auto" /></div>
            ) : itens.length === 0 ? (
              <p className="text-xs text-brand-muted italic">Nenhum lançamento manual neste mês.</p>
            ) : (
              <div className="space-y-1.5">
                {itens.map(a => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-brand-surface-2 border border-brand-border">
                    <span className="text-sm text-brand-text truncate flex-1">{a.description}</span>
                    <span className={`text-sm font-black whitespace-nowrap ${Number(a.amount) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {money(a.amount)}
                    </span>
                    <button
                      onClick={() => void remover(a)}
                      disabled={salvando}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                      title="Remover"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AjusteRepasseModal;
