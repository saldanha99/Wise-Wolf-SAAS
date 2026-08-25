import rawMarketingPages from './hubMarketingPages.json';
import type { HubMarketingRoute } from './hubRoutes';

export interface HubMarketingMetadata {
  segment: string;
  title: string;
  description: string;
  imagePath: string;
  imageAlt: string;
}

export const HUB_MARKETING_METADATA = rawMarketingPages as Record<HubMarketingRoute, HubMarketingMetadata>;

export const HUB_NOT_FOUND_METADATA = {
  title: 'Página não encontrada | Wise Wolf Hub',
  description: 'Esta página não existe ou mudou de endereço. Continue pelo início do Wise Wolf Hub.',
} as const;
