import { describe, expect, it } from 'vitest';
import { buildWordDocument, buildWordMhtml, safeFileName } from './hubExport';

describe('exportação Word do material do Hub', () => {
  it('embute o logo como parte MHTML e troca o data URL por cid', async () => {
    const text = buildWordMhtml('Ficha A2', '<article><img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"><h2>Ficha</h2></article>', 'data:image/png;base64,iVBORw0KGgo=');
    expect(buildWordDocument('x', '<p>x</p>').type).toBe('application/msword');
    expect(text).toContain('Content-Type: multipart/related');
    expect(text).toContain('src="cid:logo"');
    expect(text).toContain('Content-ID: <logo>');
    expect(text).not.toContain('src="data:image');
  });

  it('sem logo não deixa imagem quebrada nem parte de imagem', async () => {
    const text = buildWordMhtml('Ficha', '<img src="data:image/png;base64,AAAA"><p>x</p>', null);
    expect(text).not.toContain('Content-ID: <logo>');
    expect(text).toContain('src=""');
  });

  it('outra imagem do corpo não vira o logo', async () => {
    const text = buildWordMhtml('Ficha', '<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/png;base64,BBBB">', 'data:image/png;base64,iVBORw0KGgo=');
    expect(text.match(/src="cid:logo"/g)?.length).toBe(1);
    expect(text).toContain('src=""');
  });

  it('nome de arquivo seguro', () => {
    expect(safeFileName('Ficha: Aeroporto — check-in (A2)')).toBe('Ficha-Aeroporto-check-in-A2');
  });
});
