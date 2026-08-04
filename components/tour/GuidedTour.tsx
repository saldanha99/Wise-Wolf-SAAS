import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { flattenTour, FlatStep, TourRole } from '../../lib/tours';
import TourOverlay, { SpotRect } from './TourOverlay';

/**
 * Motor do tour guiado.
 *
 * Responsabilidades, nesta ordem:
 *   1. Trocar de aba quando o passo mora em outra tela.
 *   2. Achar o elemento `[data-tour="..."]` — com espera, porque a tela pode
 *      estar carregando (as telas são lazy) e o alvo ainda não existir.
 *   3. PULAR o passo cujo alvo não apareceu. A tela varia com papel, plano e
 *      dados cadastrados; travar o tour porque um card não existe é pior do que
 *      seguir sem ele.
 *   4. Marcar `profiles.onboarded` ao concluir, para não repetir a cada login.
 *
 * Só o passo com `target` precisa de elemento; passo centralizado (target null)
 * sempre aparece.
 */

const TENTATIVAS = 12;      // ~1,2s procurando o alvo antes de desistir
const INTERVALO_MS = 100;

interface Props {
  role: TourRole;
  userId: string;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Fecha o tour (concluído ou pulado). */
  onClose: () => void;
}

const GuidedTour: React.FC<Props> = ({ role, userId, activeTab, setActiveTab, onClose }) => {
  const steps = useRef<FlatStep[]>(flattenTour(role)).current;
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  const cancelado = useRef(false);

  useEffect(() => () => { cancelado.current = true; }, []);

  const encerrar = useCallback(async (concluiu: boolean) => {
    if (concluiu && userId) {
      // Falha aqui não pode travar a UI: no pior caso o tour reaparece no
      // próximo login, o que é bem menos grave do que a tela ficar presa.
      await supabase.from('profiles').update({ onboarded: true }).eq('id', userId);
    }
    onClose();
  }, [onClose, userId]);

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
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
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
