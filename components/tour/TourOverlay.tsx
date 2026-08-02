import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, ArrowLeft, ArrowRight, CheckCircle2, Compass } from 'lucide-react';
import { FlatStep } from '../../lib/tours';

/**
 * Overlay do tour: escurece a tela com um recorte ("holofote") no elemento do
 * passo e mostra o balão ao lado.
 *
 * O escurecimento é um <rect> SVG cobrindo tudo — ele também CAPTURA os cliques,
 * então a página fica inerte enquanto o tour roda. Isso é intencional: o usuário
 * navega pelo balão, não clicando por baixo, e assim o tour não perde o passo
 * porque alguém clicou em outra coisa.
 */

export interface SpotRect { x: number; y: number; w: number; h: number; }

interface Props {
  step: FlatStep;
  rect: SpotRect | null;
  index: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const PAD = 12;       // margem mínima até a borda da tela
const GAP = 14;       // distância entre alvo e balão
const HOLE_PAD = 8;   // respiro do recorte em volta do alvo

const TourOverlay: React.FC<Props> = ({ step, rect, index, total, onNext, onPrev, onClose }) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Teclado: Esc sai, setas navegam. Um tour que só se fecha no X irrita.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); }
      else if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onPrev(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev, index]);

  const isMobile = viewport.w < 768;
  const isLast = index === total - 1;

  // Abaixo do alvo → acima → à direita → à esquerda → centralizado. No celular o
  // balão vira folha fixa embaixo, acima da barra inferior.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const { w: vw, h: vh } = viewport;
    if (vw < 768) { setPos(null); return; }

    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    if (!rect) {
      setPos({ top: Math.max(PAD, vh / 2 - ph / 2), left: Math.max(PAD, vw / 2 - pw / 2) });
      return;
    }
    const clampLeft = (v: number) => Math.max(PAD, Math.min(v, vw - pw - PAD));
    const clampTop = (v: number) => Math.max(PAD, Math.min(v, vh - ph - PAD));
    const centered = clampLeft(rect.x + rect.w / 2 - pw / 2);

    const below = rect.y + rect.h + HOLE_PAD + GAP;
    if (below + ph <= vh - PAD) return setPos({ top: below, left: centered });
    const above = rect.y - HOLE_PAD - GAP - ph;
    if (above >= PAD) return setPos({ top: above, left: centered });
    const right = rect.x + rect.w + HOLE_PAD + GAP;
    if (right + pw <= vw - PAD) return setPos({ top: clampTop(rect.y + rect.h / 2 - ph / 2), left: right });
    const left = rect.x - HOLE_PAD - GAP - pw;
    if (left >= PAD) return setPos({ top: clampTop(rect.y + rect.h / 2 - ph / 2), left });
    // Alvo maior que a tela (menu inteiro, grade): centraliza por cima.
    setPos({ top: clampTop(vh / 2 - ph / 2), left: centered });
  }, [rect?.x, rect?.y, rect?.w, rect?.h, step, viewport.w, viewport.h]);

  const hole = rect ? {
    x: Math.max(0, rect.x - HOLE_PAD),
    y: Math.max(0, rect.y - HOLE_PAD),
    w: rect.w + HOLE_PAD * 2,
    h: rect.h + HOLE_PAD * 2,
  } : null;

  const transicao = { transition: 'x .28s ease, y .28s ease, width .28s ease, height .28s ease' };

  return (
    <div
      className="fixed inset-0 z-[300] print:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={`Tour guiado: ${step.title}`}
    >
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <mask id="wolf-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {hole && <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx="14" fill="black" style={transicao} />}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(2,6,23,0.74)" mask="url(#wolf-tour-mask)" />
        {hole && (
          <rect
            x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx="14"
            fill="none" stroke="#6366f1" strokeWidth="2.5" className="animate-pulse" style={transicao}
          />
        )}
      </svg>

      <div
        ref={popRef}
        className={
          'absolute w-[370px] max-w-[calc(100vw-24px)] rounded-2xl bg-brand-surface border border-brand-border shadow-2xl shadow-black/30 ' +
          'max-md:!left-3 max-md:!right-3 max-md:!top-auto max-md:bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] max-md:w-auto max-md:max-w-none'
        }
        style={isMobile ? undefined : pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      >
        <div className="p-4 md:p-5">
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-indigo-600 bg-indigo-500/10 px-2.5 py-1 rounded-full">
              <Compass size={13} /> {step.chapterTitle} · {index + 1}/{total}
            </span>
            <button
              onClick={onClose}
              title="Sair do tour"
              className="p-1.5 -m-1 rounded-lg text-brand-muted hover:text-brand-text hover:bg-brand-surface-2"
            >
              <X size={17} />
            </button>
          </div>

          <h3 className="text-base font-bold text-brand-text leading-snug">{step.title}</h3>
          <p className="text-sm text-brand-muted leading-relaxed mt-1.5">{step.text}</p>

          <div className="flex items-center gap-2 mt-4">
            <div className="flex items-center gap-1 mr-auto" aria-hidden="true">
              {Array.from({ length: total }).map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === index ? 'w-4 bg-indigo-500' : 'w-1.5 bg-brand-border'}`}
                />
              ))}
            </div>
            {index > 0 && (
              <button
                onClick={onPrev}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-sm font-bold text-brand-muted hover:bg-brand-surface-2"
              >
                <ArrowLeft size={15} /> Voltar
              </button>
            )}
            <button
              onClick={onNext}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm"
            >
              {isLast ? <>Concluir <CheckCircle2 size={15} /></> : <>Próximo <ArrowRight size={15} /></>}
            </button>
          </div>
        </div>
        <div className="px-4 md:px-5 py-2 border-t border-brand-border flex justify-between items-center">
          <button onClick={onClose} className="text-[11px] text-brand-muted hover:text-brand-text underline underline-offset-2">
            Pular o tour
          </button>
          <span className="text-[11px] text-brand-muted/60 max-md:hidden">Esc sai · ←/→ navegam</span>
        </div>
      </div>
    </div>
  );
};

export default TourOverlay;
