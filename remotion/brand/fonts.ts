import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

export const bodyFontFamily = 'Inter';
export const displayFontFamily = 'Outfit';

void Promise.all([
  loadFont({
    family: bodyFontFamily,
    url: staticFile('assets/hub/videos/fonts/Inter-Variable.woff2'),
    format: 'woff2',
    weight: '100 900',
    style: 'normal',
    display: 'block',
  }),
  loadFont({
    family: displayFontFamily,
    url: staticFile('assets/hub/videos/fonts/Outfit-Variable.woff2'),
    format: 'woff2',
    weight: '100 900',
    style: 'normal',
    display: 'block',
  }),
]);
