type RenewalMessageSource = Record<string, unknown>;

const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).replace(/ /g, " ");
const brDate = (value: string) => value.split("-").reverse().join("/");
const oneSpace = (value: unknown) =>
  String(value ?? "").trim().replace(/\s+/g, " ");

/** Condição que o aluno está assinando, nas mesmas palavras da página. */
export function renewalCondition(source: RenewalMessageSource): string {
  const term = Number(source.term_months);
  const fee = brl(Number(source.monthly_fee_cents));
  const lessons = `${source.classes_per_week} aulas por semana`;
  if (source.billing_strategy === "UPFRONT_CHARGE") {
    return `${term} meses, pagamento único de ${
      brl(Number(source.upfront_total_cents))
    } (${fee} por mês) e ${lessons}`;
  }
  if (source.billing_strategy === "UPFRONT_EXTERNAL") {
    return `${term} meses, ${fee} por mês e ${lessons}, com o pagamento integral de ${
      brl(Number(source.upfront_total_cents))
    } já recebido pela escola`;
  }
  return `${term} meses, ${fee} por mês e ${lessons}`;
}

export function renewalMessage(
  source: RenewalMessageSource,
  link: string,
): string {
  return `Olá, ${oneSpace(source.recipient_name)}! A renovação do curso de ${
    oneSpace(source.student_name)
  } está pronta.\n\nCondição: ${renewalCondition(source)}. Vigência: ${
    brDate(String(source.contract_start))
  } a ${
    brDate(String(source.service_end_date))
  }.\n\nConfira e assine pelo link individual:\n${link}\n\nSe precisar ajustar a data, fale conosco antes de assinar.`;
}
