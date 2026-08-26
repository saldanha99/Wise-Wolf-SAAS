// Config própria dos anúncios.
//
// O `remotion.config.ts` da raiz aponta o public dir para `remotion/public`. Se os
// anúncios usassem aquele diretório, cada imagem nova invalidaria os receipts comerciais
// dos 5 filmes institucionais (collectCompositionPublicAssets hasheia tudo sob
// remotion/public) e derrubaria o `release.sh`. Por isso os anúncios têm público próprio.
//
// Uso: npx remotion studio remotion-ads/index.ts --config=remotion-ads/remotion.config.ts
import { Config } from '@remotion/cli/config';

Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
// CRF 20: um pouco melhor que os 22 da raiz. A Meta recomprime o upload, então entregar
// com folga de qualidade evita somar duas perdas.
Config.setCrf(20);
Config.setAudioBitrate('192k');
Config.setVideoImageFormat('jpeg');
// bt709 é o espaço de cor que o pipeline institucional declara nos receipts e o que a
// Meta espera. Sem declarar, o arquivo sai marcado como full-range (yuvj420p) e players
// que respeitam a marcação levantam os pretos — o anúncio é escuro, então isso apareceria.
Config.setColorSpace('bt709');
Config.setOverwriteOutput(true);
Config.setConcurrency(2);
Config.setTimeoutInMilliseconds(120_000);
Config.setPublicDir('remotion-ads/public');
