import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { CheckCircle, ShieldAlert, FileText, GraduationCap, Wallet, DollarSign, ArrowRight, CheckCheck, AlertTriangle, Repeat } from 'lucide-react';

// =============================================================
// Central de Pendências do diretor: lê director_pending_counts() e mostra,
// no topo do Dashboard, tudo que precisa de ação dele, com link direto.
// =============================================================

interface Props {
  // Navega para a aba correspondente no menu lateral
  onNavigate?: (tab: string) => void;
}

interface Item {
  key: string;
  label: string;
  tab: string;
  icon: React.ElementType;
  color: string; // classes de cor do ícone/realce
}

const ITEMS: Item[] = [
  { key: 'acolhimento', label: 'Documentos de alunos para aprovar', tab: 'approvals', icon: CheckCircle, color: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30' },
  { key: 'presenca', label: 'Conflitos de presença a resolver', tab: 'attendance-disputes', icon: ShieldAlert, color: 'text-red-600 bg-red-100 dark:bg-red-900/30' },
  { key: 'materiais', label: 'Materiais aguardando aprovação', tab: 'material-approvals', icon: FileText, color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30' },
  { key: 'trials', label: 'Experimentais/Treinos a pagar', tab: 'trial-settlement', icon: GraduationCap, color: 'text-indigo-600 bg-indigo-100 dark:bg-indigo-900/30' },
  // Reposição é dívida com o aluno: a aula foi paga (falta dele) ou é obrigação
  // do professor (falta dele), e ainda não aconteceu. Sem data ela não aparece
  // em "Lançar Aula" nem em "Pendentes" — só na aba Reposições, que ninguém abre
  // sem motivo. Foi assim que o passivo chegou a 102, o mais antigo de 04/03/2026.
  { key: 'reposicoes', label: 'Reposições sem data para agendar', tab: 'reschedules', icon: Repeat, color: 'text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30' },
  { key: 'reposicoes_vencidas', label: 'Reposições com data vencida sem lançamento', tab: 'reschedules', icon: Repeat, color: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30' },
  { key: 'pagamentos_retidos', label: 'Pagamentos retidos por conflito', tab: 'attendance-disputes', icon: Wallet, color: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30' },
  { key: 'fechamentos', label: 'Fechamentos de professor pendentes', tab: 'payments', icon: DollarSign, color: 'text-purple-600 bg-purple-100 dark:bg-purple-900/30' },
  // Aluno tendo aula que NINGUÉM está cobrando. Não aparece em inadimplência —
  // cobrança que nunca foi criada não vence. Descoberto em 02/08/2026 com
  // R$ 4.663,05 já não faturados.
  { key: 'sem_assinatura', label: 'Alunos tendo aula sem cobrança ativa', tab: 'student-payments', icon: AlertTriangle, color: 'text-rose-600 bg-rose-100 dark:bg-rose-900/30' },
];

const DirectorPendingCenter: React.FC<Props> = ({ onNavigate }) => {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const loadCounts = async () => {
      try {
        const { data } = await supabase.rpc('director_pending_counts');
        if (active && data && typeof data === 'object') {
          setCounts(data as Record<string, number>);
        }
      } catch {
        // Mantém o painel silencioso quando a contagem não estiver disponível.
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadCounts();
    return () => { active = false; };
  }, []);

  const pendentes = ITEMS.filter(i => (counts[i.key] || 0) > 0);
  const total = pendentes.reduce((acc, i) => acc + (counts[i.key] || 0), 0);

  if (loading) return null;

  // Estado "tudo em dia" — feedback positivo, não polui
  if (pendentes.length === 0) {
    return (
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-4 flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center">
          <CheckCheck size={20} />
        </div>
        <div>
          <p className="font-black text-brand-text text-sm">Tudo em dia! 🎉</p>
          <p className="text-brand-muted text-xs">Nenhuma pendência aguardando sua ação.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-black text-brand-text text-lg tracking-tight">Precisa da sua atenção</h3>
          <p className="text-brand-muted text-xs">{total} {total === 1 ? 'item aguardando' : 'itens aguardando'} ação.</p>
        </div>
        <span className="text-2xl font-black text-tenant-primary">{total}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {pendentes.map(item => {
          const n = counts[item.key] || 0;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate?.(item.tab)}
              className="group flex items-center gap-3 p-3 rounded-xl border border-brand-border hover:border-tenant-primary/40 hover:bg-brand-surface-2 transition-all text-left"
            >
              <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${item.color}`}>
                <Icon size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-brand-text leading-tight">{item.label}</p>
              </div>
              <span className="shrink-0 min-w-[28px] h-7 px-2 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-black">{n}</span>
              <ArrowRight size={16} className="shrink-0 text-brand-muted group-hover:text-tenant-primary group-hover:translate-x-0.5 transition-all" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DirectorPendingCenter;
