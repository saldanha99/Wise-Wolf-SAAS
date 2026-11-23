// Títulos da biblioteca vêm do acervo da escola ("BOOK B2 Part 1,2", "AULA EXPERIMENTAL KIDS A1").
// Na vitrine do Hub o professor vê um nome de verdade; o título original continua no banco.

const KEEP_UPPER = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'TOEFL', 'IELTS', 'TOEIC', 'CEFR', 'IT', 'TI', 'AI', 'IA', 'ESP', 'USA', 'UK']);
const PROPER = new Map([['kids', 'Kids'], ['teens', 'Teens'], ['wise', 'Wise'], ['wolf', 'Wolf'], ['english', 'English'], ['business', 'Business']]);

function isMostlyUpper(text: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
  return upper / letters.length > 0.7;
}

function sentenceCase(text: string): string {
  let first = true;
  return text.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return token;
    const bare = token.replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    let out: string;
    if (KEEP_UPPER.has(bare.toUpperCase()) && /\d|^[A-ZÀ-Þ]{2,5}$/.test(bare)) out = token.toUpperCase();
    else if (PROPER.has(bare.toLowerCase())) out = token.toLowerCase().replace(bare.toLowerCase(), PROPER.get(bare.toLowerCase())!);
    else out = token.toLowerCase();
    if (first && /[a-zà-ÿ]/i.test(out)) {
      out = out.replace(/[a-zà-ÿ]/i, (c) => c.toUpperCase());
      first = false;
    } else if (first && bare) first = false;
    return out;
  }).join('');
}

export function hubDisplayTitle(raw: string): string {
  let title = (raw || '').replace(/\s+/g, ' ').trim();
  if (!title) return title;
  if (isMostlyUpper(title)) title = sentenceCase(title);
  title = title
    .replace(/\bbook\b/gi, 'Livro')
    .replace(/\bparts?\s+(\d+)\s*(?:,|&|\be\b|\band\b)\s*(\d+)\b/gi, 'Partes $1 e $2')
    .replace(/\bpart\s+(\d+)\b/gi, 'Parte $1')
    .replace(/\s+(Parte|Partes)\b/, ' — $1')
    .replace(/\s+—\s+—/g, ' —');
  return title.charAt(0).toUpperCase() + title.slice(1);
}
