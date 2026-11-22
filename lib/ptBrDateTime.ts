// Datas e horas mostradas sempre em pt-BR e 24 h, independentemente do idioma do aparelho.
// O <input type="date|time"> nativo do iPhone segue o idioma do sistema ("24 Nov 2026", "12:30 PM");
// por isso a tela mostra estes textos e deixa o input nativo só para abrir o seletor.

const WEEKDAYS_SHORT = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];

/** "2026-11-24" → "ter., 24/11/2026". Data inválida → "". */
export function formatDatePtBr(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCDate() !== Number(d)) return '';
  return `${WEEKDAYS_SHORT[date.getUTCDay()]}, ${d}/${mo}/${y}`;
}

/** "07:05" / "7:05" / "19:00:00" → "07:05" / "19:00" (24 h). Inválida → "". */
export function formatTime24(value: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || '');
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Data local de hoje no formato do input ("YYYY-MM-DD"), sem o salto do UTC à noite. */
export function todayLocalIso(now = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}
