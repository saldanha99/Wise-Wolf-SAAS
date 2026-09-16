import type { FlatStep, TourRole, TourStep } from './tours';

/**
 * Tours de novidade — TODA funcionalidade nova sobe com um tutorial guiado.
 *
 * Regra da direção (16/09/2026): quem abre a plataforma depois de uma
 * atualização é levado pela mão até a novidade, uma vez, e pode rever depois
 * em "Novidades" no menu do avatar. O motor é o mesmo do tour de boas-vindas
 * (`components/tour/GuidedTour`), e o "já vi" fica em `feature_tour_views`
 * (por usuário, vale em qualquer aparelho).
 *
 * Como adicionar o tour de uma release:
 *   1. Marque na tela o que o tour aponta com `data-tour="<alvo>"`.
 *   2. Acrescente uma entrada AO FIM desta lista, com id `AAAA-MM-DD-slug`
 *      (a data da release) e os papéis que ganham a novidade.
 *   3. `lib/featureTours.test.ts` recusa id repetido, fora de ordem e alvo que
 *      não existe no código — o tour nasce amarrado à tela.
 *
 * ⚠️ O motor pula passo cujo alvo não está na tela (celular, papel sem o
 * recurso, layout diferente). Escreva cada passo para se sustentar sozinho.
 */

export interface FeatureTour {
  /** `AAAA-MM-DD-slug` — a data é a da release; a lista fica em ordem cronológica. */
  id: string;
  /** Título curto, aparece no cabeçalho do balão e no menu "Novidades". */
  title: string;
  roles: TourRole[];
  steps: TourStep[];
}

export const FEATURE_TOURS: FeatureTour[] = [
  {
    id: '2026-09-16-menu-no-topo',
    title: 'Menu no topo e atalhos',
    roles: ['SCHOOL_ADMIN', 'TEACHER'],
    steps: [
      {
        target: null,
        view: 'dashboard',
        title: 'Novidade: o menu mudou de lugar ✨',
        text: 'As telas agora ficam em categorias no topo, e um trilho à esquerda guarda seus atalhos. Leva 30 segundos para conhecer — dá para sair quando quiser e rever em "Novidades" no menu do seu avatar.',
      },
      {
        target: 'sidebar-nav',
        view: 'dashboard',
        title: 'Categorias no topo',
        text: 'Passe o mouse ou clique numa categoria para ver as telas dela. O que não couber na largura da sua tela vai para "Mais". Número vermelho na categoria é pendência esperando você.',
      },
      {
        target: 'shortcut-rail',
        view: 'dashboard',
        title: 'Seus atalhos',
        text: 'Este trilho é seu: arraste qualquer tela de uma categoria para cá, arraste os ladrilhos para reordenar, passe o mouse e use o "×" para tirar. O "+" no fim lista todas as telas para marcar. Cabem 10.',
      },
      {
        target: 'nav-layout-toggle',
        view: 'dashboard',
        title: 'Prefere o menu na lateral?',
        text: 'Este botão alterna entre o menu no topo e a lateral clássica. A escolha é sua e fica salva — cada pessoa monta o próprio jeito de trabalhar.',
      },
      {
        target: null,
        view: 'dashboard',
        title: 'Pronto! 🎉',
        text: 'Perfil, tour guiado, novidades e sair ficam no menu do seu avatar, no canto superior direito.',
      },
    ],
  },
];

/** Tours do papel que a pessoa ainda não viu, na ordem em que saíram. */
export function pendingFeatureTours(role: string, seenIds: Iterable<string>): FeatureTour[] {
  const seen = new Set(seenIds);
  return FEATURE_TOURS.filter(t => t.roles.includes(role as TourRole) && !seen.has(t.id));
}

/** Tour mais recente do papel — é o que "Novidades" reabre. */
export function latestFeatureTourFor(role: string): FeatureTour | undefined {
  return [...FEATURE_TOURS].reverse().find(t => t.roles.includes(role as TourRole));
}

/** Passos achatados para o motor, todos sob o capítulo "Novidade". */
export const flattenFeatureTour = (tour: FeatureTour): FlatStep[] =>
  tour.steps.map(s => ({ ...s, chapterTitle: 'Novidade' }));
