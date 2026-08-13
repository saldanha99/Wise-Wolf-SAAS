import React, { useEffect, useState } from 'react';
import { Flame, TrendingUp, Lock, Users, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { describePayTiers, brl } from '../lib/payTiers';

// Card de retenção/dopamina do professor: mostra o "turbo" (mês sem faltar destrava
// faixas por antiguidade) + ganhos lançados vs potencial. Lê teacher_pay_projection.
//
// ⚠️ Duas coisas que este card já errou e não podem voltar:
//  1. Falava "você está há {days_clean} dias sem faltar". A apuração virou MENSAL
//     em 02/08/2026 e `teacher_turbo_status` deixou de devolver esse campo — a
//     tela mostrava "há undefined dias". Pior: como `days_to_activate` também
//     sumiu, o professor BLOQUEADO POR FALTA lia "Requisitos completos".
//  2. Prometia "5º ao 9º: R$ 9,50" em texto fixo, faixa que não existe na tabela
//     da escola. Agora o texto sai de `tiers` (o que a folha realmente paga).

interface Props { teacherId: string; }

const TeacherTurboCard: React.FC<Props> = ({ teacherId }) => {
  const [p, setP] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!teacherId) return;
    (async () => {
      const { data } = await supabase.rpc('teacher_pay_projection', { p_teacher: teacherId });
      setP(data);
      setLoading(false);
    })();
  }, [teacherId]);

  if (loading || !p) return null;

  const turbo = p.turbo || {};
  const active = turbo.active === true;
  const logged = Number(p.amount_logged || 0);
  const potential = Number(p.amount_potential_turbo || 0);
  const leftOnTable = Math.max(0, potential - logged);
  const toNext = p.students_to_next;
  // Regra 04/07/2026: turbo só destrava a partir de 10 alunos ativos
  const studentsActive = Number(turbo.students_active || 0);
  const studentsMissing = Number(turbo.students_missing || 0);
  // A tabela de faixas vem do servidor — nenhum valor de aula é escrito aqui.
  const faixas = describePayTiers(p.tiers);
  // Por que o turbo está desligado, na linguagem da regra vigente (mês fechado).
  const bloqueio: Record<string, string> = {
    falta_neste_mes: 'Você tem falta lançada neste mês: o turbo só volta no mês que fechar sem nenhuma falta sua.',
    falta_mes_passado: 'Houve falta sua no mês passado. Fechando este mês inteiro sem faltar, o turbo volta no mês seguinte.',
    conflito: 'Há aula em análise por divergência com o aluno. Resolvido isso, o turbo destrava.',
    sem_aula_lancada_no_mes: 'Assim que você lançar a primeira aula do mês, o turbo é reavaliado.',
  };
  const motivo = bloqueio[String(turbo.blocked_by || '')] || null;

  return (
    <div className={`relative overflow-hidden rounded-3xl p-6 border ${active
      ? 'border-orange-300 dark:border-orange-700 bg-gradient-to-br from-orange-500 via-red-500 to-amber-500 text-white shadow-xl shadow-orange-500/30'
      : 'border-brand-border bg-brand-surface'}`}>

      {active && (
        <div className="absolute -right-6 -top-6 opacity-20">
          <Flame size={140} />
        </div>
      )}

      <div className="relative">
        <div className="flex items-center gap-2 mb-4">
          {active ? (
            <>
              <Flame size={22} className="text-yellow-200 animate-pulse" />
              <span className="font-black uppercase tracking-widest text-sm">Turbo Ativo</span>
              <span className="ml-auto text-[10px] font-black uppercase bg-white/20 px-3 py-1 rounded-full">🔥 não pode faltar!</span>
            </>
          ) : (
            <>
              <Lock size={18} className="text-brand-muted" />
              <span className="font-black uppercase tracking-widest text-xs text-brand-muted">Turbo bloqueado</span>
            </>
          )}
        </div>

        {/* Ganhos */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <p className={`text-[10px] font-black uppercase tracking-widest ${active ? 'text-white/70' : 'text-brand-muted'}`}>Lançado no mês</p>
            <p className="text-2xl font-black mt-0.5">{brl(logged)}</p>
          </div>
          <div>
            <p className={`text-[10px] font-black uppercase tracking-widest ${active ? 'text-white/70' : 'text-brand-muted'}`}>Potencial do mês</p>
            <p className="text-2xl font-black mt-0.5 flex items-center gap-1">
              <TrendingUp size={16} /> {brl(potential)}
            </p>
          </div>
        </div>

        {leftOnTable > 0 && (
          <div className={`text-xs font-bold rounded-xl px-3 py-2 mb-3 ${active ? 'bg-white/15' : 'bg-amber-50 dark:bg-amber-900/20 text-amber-600'}`}>
            <Sparkles size={12} className="inline mr-1" />
            Faltam <b>{brl(leftOnTable)}</b> pra fechar o mês cheio — é só lançar todas as aulas certinho.
          </div>
        )}

        {/* Estado do turbo */}
        {active ? (
          <p className="text-xs font-bold text-white/90">
            Turbo valendo <b>neste mês inteiro</b>, com <b>{studentsActive} aluno{studentsActive === 1 ? '' : 's'} na carteira</b>.
            {faixas ? <> Na sua carteira, <b>{faixas}</b>.</> : null} Uma falta sua trava o turbo neste mês e no próximo — falta do aluno não trava.
          </p>
        ) : (
          <div className="space-y-2">
            {studentsMissing > 0 && (
              <div className="text-xs font-bold rounded-xl px-3 py-2 bg-brand-surface-2 border border-brand-border text-brand-text">
                🎯 Faltam <b>{studentsMissing} aluno{studentsMissing === 1 ? '' : 's'}</b> para você poder ativar o turbo: o benefício destrava a partir de <b>10 alunos na carteira</b> (hoje você tem {studentsActive}). Quanto mais assiduidade e qualidade, mais alunos a escola te envia.
              </div>
            )}
            {motivo && (
              <p className="text-xs font-bold text-brand-muted">
                {motivo}{faixas ? <> Com o turbo ligado, <b className="text-brand-text">{faixas}</b>.</> : null}
              </p>
            )}
            {studentsMissing === 0 && !motivo && (
              <p className="text-xs font-bold text-brand-muted">
                Requisitos completos — o turbo ativa automaticamente no próximo cálculo. Continue sem faltar!
              </p>
            )}
          </div>
        )}

        {toNext != null && (
          <div className={`flex items-center gap-1.5 mt-3 text-[11px] font-bold ${active ? 'text-white/80' : 'text-brand-muted'}`}>
            <Users size={12} /> Falta {toNext} aluno(s) pra chegar na faixa de {brl(Number(p.next_tier_rate || 0))}/aula.
          </div>
        )}
      </div>
    </div>
  );
};

export default TeacherTurboCard;
