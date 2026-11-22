import React, { useEffect, useState } from 'react';
import { getWolfieOpener, type WolfieOpener } from '../../services/wolfieLessonTrackService';

/**
 * Abertura personalizada do tutor (22/11/2026): uma frase com o primeiro nome do aluno e o último
 * assunto da aula aprovada (ou o objetivo dele, sem aula). Gerada 1x por aula no servidor
 * (wolfie-lesson-track, ação "opener") e guardada na sessão do navegador. O rótulo usa o nome do
 * tutor do tenant (white label); sem configuração, "Wolfie".
 */
export const WolfieOpenerBubble: React.FC<{ className?: string; tone?: 'dark' | 'emerald' }> = ({
  className = '',
  tone = 'dark',
}) => {
  const [opener, setOpener] = useState<WolfieOpener | null>(null);

  useEffect(() => {
    let alive = true;
    void getWolfieOpener().then((value) => {
      if (alive) setOpener(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!opener) return null;
  const palette = tone === 'emerald'
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-50'
    : 'border-white/10 bg-white/[0.06] text-slate-100';
  return (
    <div className={`rounded-2xl border px-4 py-3 ${palette} ${className}`} data-testid="wolfie-opener">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">{opener.tutorName}</p>
      <p className="mt-1 text-sm leading-relaxed sm:text-base">{opener.opener}</p>
    </div>
  );
};

export default WolfieOpenerBubble;
