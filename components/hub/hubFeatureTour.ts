import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import type { FlatStep } from '../../lib/tours';

// Tour de novidade do Hub (o portal do Hub não passa pelo App.tsx, onde mora o
// motor da escola). Mesmo "já vi" por usuário (`feature_tour_views`), vale em
// qualquer aparelho. Erro na leitura não abre tour nenhum.

export const HUB_FASE2_TOUR_ID = '2026-11-24-hub-ferramentas-por-habilidade';

export const HUB_FASE2_TOUR_STEPS: FlatStep[] = [
  {
    chapterTitle: 'Novidade no Educador IA',
    target: 'hub-educator-modes',
    view: 'tools',
    title: 'Novidade: ferramentas por habilidade ✨',
    text: 'O Educador IA ganhou 17 ferramentas organizadas por leitura, vocabulário, fala, escrita e gramática, mais o verificador de nível e a adaptação de material. Tudo nesta barra.',
  },
  {
    chapterTitle: 'Novidade no Educador IA',
    target: 'hub-tools-catalog',
    view: 'tools',
    title: 'Escolha a ferramenta',
    text: 'Filtre pela habilidade ou busque pelo nome. Cada ferramenta tem um formulário curto e sai com gabarito para você e uma versão limpa para o aluno.',
  },
  {
    chapterTitle: 'Novidade no Educador IA',
    target: 'hub-cefr-checker',
    view: 'cefr',
    title: 'Verificar nível',
    text: 'Cole um texto e veja o nível CEFR, os trechos difíceis e, se quiser, a versão simplificada para o nível do seu aluno.',
  },
  {
    chapterTitle: 'Novidade no Educador IA',
    target: 'hub-authentic-adapter',
    view: 'adapt',
    title: 'Adaptar material',
    text: 'Notícia, post ou página: cole o texto, mande o link ou um print. Volta no nível do aluno, com atividade e a fonte citada.',
  },
];

export function useHubFeatureTour(userId: string | undefined, tourId: string) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    supabase
      .from('feature_tour_views')
      .select('tour_id')
      .eq('user_id', userId)
      .eq('tour_id', tourId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (active) setPending(!error && !data);
      });
    return () => { active = false; };
  }, [userId, tourId]);

  const markSeen = useCallback(async () => {
    if (!userId) return;
    await supabase
      .from('feature_tour_views')
      .upsert({ user_id: userId, tour_id: tourId }, { onConflict: 'user_id,tour_id', ignoreDuplicates: true });
  }, [userId, tourId]);

  return { pending, markSeen, close: () => setPending(false) };
}
