// Paleta dos anúncios.
//
// O repositório tem TRÊS identidades que não conversam entre si:
//   1. Logo da escola      — carmim #CC213B + navy #0D0D6E (amostrado do PNG oficial)
//   2. App / SaaS          — navy #002366 + vermelho #D32F2F (index.css, lib/tenant-branding.ts)
//   3. Vídeos institucionais — quase-preto #07080b + coral/violeta/ciano/menta
//
// Note que o vermelho do app (#D32F2F) NÃO é o vermelho do logo (#CC213B): são dois
// vermelhos convivendo como se fossem a mesma marca. Não é este projeto que resolve isso.
//
// A decisão aqui: os anúncios herdam a base escura dos vídeos (é onde a interface do
// produto aparece melhor e onde já existe um sistema visual maduro), e trazem o carmim
// do LOGO como cor de assinatura da escola — porque é o único vermelho que aparece ao
// lado da marca no fim do filme. Assim o anúncio termina coerente com o logotipo que
// ele mostra, em vez de terminar com um vermelho de interface que ninguém reconhece.

export const adBrand = {
  background: '#07080b',
  backgroundLift: '#0c0e14',
  surface: '#101116',
  surfaceStrong: '#17191f',
  ink: '#ffffff',
  inkSoft: '#d7d4d0',
  muted: '#9699a4',
  line: 'rgba(255, 255, 255, 0.12)',

  /** Carmim do logotipo oficial da escola. */
  schoolCarmine: '#CC213B',
  /** Navy do logotipo ("LANGUAGES"). */
  schoolNavy: '#0D0D6E',
} as const;

/** Sombra de texto usada quando a tipografia cai sobre imagem. */
export const textOnImageShadow = '0 2px 30px rgba(0,0,0,0.55), 0 1px 4px rgba(0,0,0,0.4)';

export const LOGO_FILE = 'assets/marca/wise-wolf-logo-horizontal-dark.png';
