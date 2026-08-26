import type { AdScript } from '../types';
import { HUB_ADS } from './hub-ads';
import { STUDENT_ADS } from './student-ads';

/** Catálogo único. A ordem define a ordem das composições no Studio. */
export const ALL_ADS: AdScript[] = [...STUDENT_ADS, ...HUB_ADS];

export const adBySlug = (slug: string): AdScript => {
  const found = ALL_ADS.find((ad) => ad.slug === slug);
  if (!found) throw new Error(`Anúncio desconhecido: ${slug}`);
  return found;
};
