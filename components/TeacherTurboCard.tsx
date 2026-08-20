import React, { useEffect, useState } from 'react';
import { Flame, TrendingUp, Lock, Users, Sparkles, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { describePayTiers, brl } from '../lib/payTiers';

// Card do professor: a fonte autoritativa é teacher_pay_projection. A regra do
// Turbo é uma ofensiva contínua de 30 dias e exige carteira de 10 alunos.
// Valores/faixas continuam vindo do servidor; nada financeiro é fixado na UI.

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
  const suspended = turbo.turbo_status === 'SUSPENDED' || turbo.status === 'SUSPENDED';
  const logged = Number(p.amount_logged || 0);
  const potential = Number(p.amount_potential_turbo || 0);
  const leftOnTable = Math.max(0, potential - logged);
  const toNext = p.students_to_next;
  // Regra 04/07/2026: turbo só destrava a partir de 10 alunos ativos
  const studentsActive = Number(turbo.students_active || 0);
  const studentsMissing = Number(turbo.students_missing || 0);
  const streakDays = Number(turbo.streak_days || turbo.days_clean || 0);
  const daysToActivate = Number(turbo.days_to_activate ?? Math.max(0, 30 - streakDays));
  const activeDays = Number(turbo.active_days || 0);
  // A tabela de faixas vem do servidor — nenhum valor de aula é escrito aqui.
  const faixas = describePayTiers(p.tiers);
  // Por que o turbo está desligado, na linguagem da regra de ofensiva.
  const bloqueio: Record<string, string> = {
    carteira: 'O Turbo fica disponível a partir de 10 alunos ativos na carteira.',
    ofensiva: `Faltam ${daysToActivate} dia${daysToActivate === 1 ? '' : 's'} sem falta para ativar o Turbo.`,
    conflito: 'Há um relato de falta em análise. O Turbo fica suspenso até a diretoria decidir.',
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
          ) : suspended ? (
            <>
              <ShieldAlert size={18} className="text-red-500" />
              <span className="font-black uppercase tracking-widest text-xs text-red-600">Turbo suspenso para análise</span>
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
            Turbo ativo há <b>{activeDays} dia{activeDays === 1 ? '' : 's'}</b>, com uma ofensiva de <b>{streakDays} dias sem falta</b> e <b>{studentsActive} aluno{studentsActive === 1 ? '' : 's'} na carteira</b>.
            {faixas ? <> Na sua carteira, <b>{faixas}</b>.</> : null} Uma falta sua reinicia a ofensiva em zero; falta do aluno não interfere.
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
                Você está há <b>{streakDays} dias sem falta</b>. Faltam <b>{daysToActivate} dias</b> para ativar automaticamente.
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
