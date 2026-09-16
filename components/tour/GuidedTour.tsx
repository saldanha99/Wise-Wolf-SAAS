import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatStep } from '../../lib/tours';
import TourOverlay, { SpotRect } from './TourOverlay';

/**
 * Motor do tour guiado.
 *
 * Responsabilidades, nesta ordem:
 *   1. Trocar de aba quando o passo mora em outra tela.
 *   2. Achar o elemento `[data-tour="..."]` — com espera, porque a tela pode
 *      estar carregando (as telas são lazy) e o alvo ainda não existir.
 *   3. PULAR o passo cujo alvo não apareceu — ou está no DOM mas invisível
 *      (`hidden lg:flex` no celular). A tela varia com papel, plano, layout e
 *      dados cadastrados; travar o tour porque um card não existe é pior do que
 *      seguir sem ele.
 *   4. Avisar quem chamou ao terminar (`onFinish`), que decide o que gravar:
 *      `profiles.onboarded` no tour de boas-vindas, `feature_tour_views` no
 *      tour de novidade. O motor não sabe de qual tour se trata — é o mesmo
 *      para os dois, e é isso que faz "toda release sobe com tour" custar só
 *      uma entrada em `lib/featureTours.ts`.
 *
 * Só o passo com `target` precisa de elemento; passo centralizado (target null)
 * sempre aparece.
 */

const TENTATIVAS = 12;      // ~1,2s procurando o alvo antes de desistir
const INTERVALO_MS = 100;

interface Props {
  steps: FlatStep[];
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /**
   * Chamado ao concluir OU pular — nos dois casos a pessoa já viu e não deve
   * receber de novo. Falha aqui não pode travar a UI (é aguardada, mas o
   * `onClose` vem sempre).
   */
  onFinish: () => Promise<void> | void;
  /** Fecha o tour (concluído ou pulado). */
  onClose: () => void;
}

const GuidedTour: React.FC<Props> = ({ steps: stepsProp, activeTab, setActiveTab, onFinish, onClose }) => {
  const steps = useRef<FlatStep[]>(stepsProp).current;
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  const cancelado = useRef(false);

  useEffect(() => () => { cancelado.current = true; }, []);

  const encerrar = useCallback(async (concluiu: boolean) => {
    if (concluiu) {
      // Falha aqui não pode travar a UI: no pior caso o tour reaparece no
      // próximo login, o que é bem menos grave do que a tela ficar presa.
      try { await onFinish(); } catch (e) { console.warn('[tour] não foi possível registrar a conclusão', e); }
    }
    onClose();
  }, [onClose, onFinish]);

  // Posiciona o holofote no passo atual, navegando de aba se preciso.
  useEffect(() => {
    let vivo = true;
    const step = steps[index];
    if (!step) { void encerrar(true); return; }

    if (step.view && step.view !== activeTab) {
      setActiveTab(step.view);
      return; // o efeito roda de novo quando activeTab mudar
    }

    if (!step.target) { setRect(null); return; }

    let tentativa = 0;
    const procurar = () => {
      if (!vivo || cancelado.current) return;
      // Vários elementos podem levar o mesmo alvo (menu lateral e barra do topo
      // são ambos `sidebar-nav`); vale o primeiro que está de fato visível.
      const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${step.target}"]`))
        .find(candidate => candidate.getClientRects().length > 0);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Espera o scroll assentar antes de medir, senão o holofote fica torto.
        window.setTimeout(() => {
          if (!vivo || cancelado.current) return;
          const r = el.getBoundingClientRect();
          setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
        }, 220);
        return;
      }
      if (++tentativa >= TENTATIVAS) {
        // Alvo não existe nesta configuração: segue para o próximo.
        setRect(null);
        setIndex(i => Math.min(i + 1, steps.length));
        return;
      }
      window.setTimeout(procurar, INTERVALO_MS);
    };
    procurar();

    return () => { vivo = false; };
  }, [index, activeTab, steps, setActiveTab, encerrar]);

  const step = steps[index];
  if (!step) return null;

  return (
    <TourOverlay
      step={step}
      rect={rect}
      index={index}
      total={steps.length}
      onNext={() => (index + 1 >= steps.length ? void encerrar(true) : setIndex(index + 1))}
      onPrev={() => setIndex(i => Math.max(0, i - 1))}
      onClose={() => void encerrar(true)}
    />
  );
};

export default GuidedTour;
