// Exportação de material do Hub para o Word, sem dependência: arquivo .doc em MHTML (HTML com a
// imagem do logo embutida), que o Word abre direto. O PDF continua pela impressão do navegador.

const WORD_STYLE = `
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; }
  h1, h2 { font-size: 18pt; margin: 0 0 6pt; } h3 { font-size: 13pt; margin: 12pt 0 4pt; }
  p, li { line-height: 1.35; } .brand { width: 100%; border-bottom: 1px solid #999; margin-bottom: 10pt; }
  .brand td { vertical-align: middle; } .brand img { max-height: 60px; max-width: 180px; }
  button, svg, [data-export-skip] { display: none; }
`;

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Logo reduzido no navegador (máx. 400 px, PNG) para caber no limite da conta. */
export async function resizeLogo(file: File, max = 400): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Use uma imagem PNG, JPG ou WEBP.');
  if (file.size > 5 * 1024 * 1024) throw new Error('A imagem passa de 5 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não consegui ler a imagem.'));
      el.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 390_000) throw new Error('O logo ficou grande demais; use uma imagem mais simples.');
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Monta o .doc (MHTML) com o HTML do material e o logo embutido. */
export function buildWordMhtml(title: string, bodyHtml: string, logoDataUrl?: string | null): string {
  const boundary = `----=_WiseWolfHub_${Date.now().toString(36)}`;
  const logo = logoDataUrl?.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${WORD_STYLE}</style></head><body>${bodyHtml.replace(
    /src="data:image\/[^"]+"/g,
    logo ? 'src="cid:logo"' : 'src=""',
  )}</body></html>`;
  const parts = [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    'Content-Location: material.html',
    '',
    html,
  ];
  if (logo) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${logo[1]}`,
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo>',
      'Content-Location: logo',
      '',
      logo[2].replace(/(.{76})/g, '$1\n'),
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

export function buildWordDocument(title: string, bodyHtml: string, logoDataUrl?: string | null): Blob {
  return new Blob([buildWordMhtml(title, bodyHtml, logoDataUrl)], { type: 'application/msword' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export const safeFileName = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'material';
