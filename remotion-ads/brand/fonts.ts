// Mesma tipografia dos filmes institucionais, para que anúncio e site não pareçam
// duas marcas diferentes. Carregada de novo aqui porque este projeto é um root
// Remotion separado e não compartilha o bundle com `remotion/`.
import { loadFont as loadDmSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadManrope } from '@remotion/google-fonts/Manrope';

export const { fontFamily: bodyFontFamily } = loadDmSans('normal', {
  weights: ['400', '500', '600', '700'],
  subsets: ['latin'],
});

export const { fontFamily: displayFontFamily } = loadManrope('normal', {
  weights: ['500', '600', '700', '800'],
  subsets: ['latin'],
});
