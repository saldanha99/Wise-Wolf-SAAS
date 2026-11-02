import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { parseLessonLinks, type LessonLinksResult } from '../../lib/lessonLinks';

export function todayInSaoPaulo(offsetDays = 0): string {
  const base = new Date(Date.now() + offsetDays * 86_400_000);
  return base.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Aulas do período com o link certo, relidas a cada minuto com a aba visível
 * e ao voltar para ela (a sala da escola pode ficar pronta a qualquer momento).
 * Erro de leitura mantém o que já estava na tela e marca `error`.
 */
export function useLessonLinks(from: string, to: string, enabled = true) {
  const [result, setResult] = useState<LessonLinksResult | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(enabled);

  const load = useCallback(async () => {
    if (!enabled || document.visibilityState !== 'visible') return;
    try {
      const { data, error: rpcError } = await supabase.rpc('my_lesson_links', { p_from: from, p_to: to });
      if (rpcError) throw rpcError;
      setResult(parseLessonLinks(data));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [enabled, from, to]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const onVisible = () => { void load(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, 60_000);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  return { result, error, loading, reload: load };
}

/** Relógio que anda a cada `ms` — para "agora", "em breve" e o aviso. */
export function useNow(ms = 20_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
