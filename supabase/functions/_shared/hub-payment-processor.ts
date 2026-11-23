/**
 * Quem aparece como recebedor no PIX, no boleto e na fatura do cartão do Hub: a conta Asaas é o
 * MEI da responsável pela Wise Wolf, sem nome fantasia (em MEI a razão social é o nome da pessoa,
 * e isso não muda por API). Mostrado ANTES do pagamento, no e-mail de confirmação e nos Termos
 * (decisão do Vinícius, 23/11/2026). Mudou a conta Asaas → muda aqui e a versão dos Termos.
 */
export const HUB_PAYMENT_PROCESSOR_NAME = "55.806.029 Debora Alves Fernandes";
export const HUB_PAYMENT_PROCESSOR_CNPJ = "55.806.029/0001-57";
export const HUB_PAYMENT_PROCESSOR_NOTICE =
  `Pagamento processado por ${HUB_PAYMENT_PROCESSOR_NAME} (CNPJ ${HUB_PAYMENT_PROCESSOR_CNPJ}), empresa responsável pela Wise Wolf.`;
