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
