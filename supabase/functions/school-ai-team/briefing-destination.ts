// Destino do resumo diário da equipe de IA. O telefone do admin costuma ser o
// próprio número central, e mensagem para si mesmo não avisa ninguém (05/11/2026):
// por isso o grupo da Direção vem antes dele. O número escolhido na configuração
// da equipe de IA continua valendo primeiro, porque é decisão explícita da escola.

const asPhone = (raw: string | null | undefined): string | null => {
  let phone = (raw || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.length >= 12 ? phone : null;
};

export function briefingDestination(input: {
  ownerWhatsapp?: string | null;
  directionGroup?: string | null;
  ownerPhone?: string | null;
}): string | null {
  return asPhone(input.ownerWhatsapp) ||
    input.directionGroup?.trim() ||
    asPhone(input.ownerPhone);
}
