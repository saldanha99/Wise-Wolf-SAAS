import React, { useEffect, useState } from 'react';
import { Flame, TrendingUp, Lock, Users, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';

// Card de retenção/dopamina do professor: mostra o "turbo" (1 mês sem faltar destrava
// faixas por antiguidade) + ganhos lançados vs potencial. Lê teacher_pay_projection.

interface Props { teacherId: string; }
const brl = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

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
            Você está há <b>{turbo.days_clean} dias</b> sem faltar. Mantendo a ofensiva, seus alunos do 5º ao 9º valem <b>R$ 9,50</b> e do 10º em diante <b>R$ 10,50</b> por aula. Uma falta zera o turbo!
          </p>
        ) : (
          <p className="text-xs font-bold text-brand-muted">
            Faltam <b className="text-brand-text">{turbo.days_to_activate} dias</b> sem faltar pra destravar o turbo e ganhar mais por aluno (5º-9º: R$9,50 · 10º+: R$10,50).
          </p>
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
