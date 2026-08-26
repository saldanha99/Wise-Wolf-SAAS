import React from 'react';
import { Img, staticFile } from 'remotion';
import { LOGO_FILE } from '../brand/tokens';
import { fs, type AdLayout } from './layout';

/**
 * Assinatura da marca.
 *
 * O logotipo oficial é 1024x323 com o lobo em knockout (alpha zero) — ele assume a cor do
 * que estiver atrás. Por isso o lockup SEMPRE vai sobre fundo escuro sólido; sobre imagem
 * clara o lobo desaparece. Não existe versão para fundo claro no repositório.
 */
export const Lockup: React.FC<{ layout: AdLayout; width?: number }> = ({ layout, width }) => {
  const logoWidth = width ?? fs(layout, layout.vertical ? 340 : 300, 120);
  return (
    <Img
      src={staticFile(LOGO_FILE)}
      style={{ width: logoWidth, height: 'auto', display: 'block' }}
    />
  );
};

/**
 * Marca discreta de canto, presente do primeiro ao último quadro.
 *
 * Fica DENTRO da zona segura, ocupando a faixa que `layout.markHeight` reserva. Acima
 * dela o app desenha foto e nome do perfil; abaixo começa o conteúdo. Sem essa reserva o
 * texto da cena cai por cima do logotipo — o bug que os filmes institucionais têm nas
 * cenas Product e Proof.
 */
export const CornerMark: React.FC<{ layout: AdLayout }> = ({ layout }) => (
  <div
    style={{
      position: 'absolute',
      zIndex: 60,
      left: layout.safe.x,
      top: layout.safe.y,
      height: layout.markHeight,
      display: 'flex',
      alignItems: 'center',
      opacity: 0.92,
    }}
  >
    <Lockup layout={layout} width={fs(layout, 176, 84)} />
  </div>
);
