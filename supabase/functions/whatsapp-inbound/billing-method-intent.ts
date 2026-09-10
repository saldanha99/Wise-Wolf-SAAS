// Detecção de intenção de troca de forma de pagamento de alunos e geração de
// resposta autônoma segura para o WhatsApp da escola.

function normalizeText(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identifica se a mensagem do aluno expressa intenção de alterar ou cadastrar
 * uma nova forma de pagamento (ex.: de Pix para Cartão de Crédito).
 */
export function isStudentBillingMethodChangeIntent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const n = normalizeText(text);
  if (n.length < 5) return false;

  // Frases que são apenas confirmação de pagamento passado ou envio de comprovante não são troca
  const isPastConfirmation =
    /^(ja )?(paguei|fiz o pagamento|mandei o pix|ta pago|transferi|comprovante)\b/.test(n) &&
    !/(mas |so que |queria |quero |como |troc|mud|alter)/.test(n);
  if (isPastConfirmation) return false;

  // Padrão 1: "trocar/mudar/alterar forma/meio de pagamento"
  const changeMethodPattern =
    /\b(trocar|troca|mudar|muda|mudanca|alterar|alteracao|atualizar|atualizacao)\b.*?\b(forma|meio|metodo|tipo|opcao)\b.*?\b(de )?(pagamento|pagar|cobranca)\b/;
  if (changeMethodPattern.test(n)) return true;

  // Padrão 2: "forma/meio de pagamento" com verbo de ação ou querer
  const methodWithActionPattern =
    /\b(forma|meio|metodo)\b.*?\b(de )?(pagamento|pagar|cobranca)\b.*?\b(trocar|mudar|alterar|atualizar|cartao)\b/;
  if (methodWithActionPattern.test(n)) return true;

  // Padrão 3: Menção explícita de passar/mudar/trocar para cartão/crédito/recorrência
  const toCardPattern =
    /\b(trocar|troca|mudar|muda|passar|passo|por|botar|colocar|cadastrar|cadastro|migrar|inserir)\b.*?\b(para |pro |no )?(cartao|credito|recorrencia|recorrente)\b/;
  if (toCardPattern.test(n)) return true;

  // Padrão 4: Pergunta de viabilidade de pagar no cartão em vez de Pix
  const cardInsteadOfPixPattern =
    /\b(cartao|credito)\b.*?\b(em vez de|ao inves de|no lugar d[eo]|sair d[eo]|trocar d[eo]|em vez do)\b.*?\b(pix|boleto)\b/;
  if (cardInsteadOfPixPattern.test(n)) return true;

  const pixToCardPattern =
    /\b(pix|boleto)\b.*?\b(para |pro |pelo |no |por )\b.*?\b(cartao|credito)\b/;
  if (pixToCardPattern.test(n)) return true;

  // Padrão 5: "quero cadastrar meu cartão", "como cadastro meu cartão", "posso cadastrar meu cartão"
  const registerCardPattern =
    /\b(quero|queria|como|posso|consigo|da para|tem como|gostaria de)\b.*?\b(cadastr|coloc|pass|pag|us)\w*\b.*?\b(meu )?(cartao|credito)\b/;
  if (registerCardPattern.test(n)) return true;

  // Padrão 6: "como faço para pagar com/no cartão"
  const howToPayWithCardPattern =
    /\b(como|posso|tem como|da pra|da para|gostaria de|quero)\b.*?\b(pagar|fazer o pagamento)\b.*?\b(no|com|via|por|pelo)\b.*?\b(cartao|credito)\b/;
  if (howToPayWithCardPattern.test(n)) return true;

  // Padrão 7: "aceita cartão para as mensalidades", "tem opção de cartão recorrente"
  const cardOptionPattern =
    /\b(tem|tem como|opcao de|aceita|fazer no)\b.*?\b(cartao|credito|recorrencia|debito automatico)\b.*?\b(mensalidade|mensalidades|recorrente|plano)\b/;
  if (cardOptionPattern.test(n)) return true;

  return false;
}

export interface StudentBillingMethodChangeReplyOptions {
  studentName?: string | null;
  schoolName?: string | null;
  portalUrl?: string | null;
}

/**
 * Gera a resposta personalizada e autônoma orientando o aluno a trocar a forma
 * de pagamento no Portal do Aluno com segurança.
 */
export function studentBillingMethodChangeReply(
  options?: StudentBillingMethodChangeReplyOptions,
): string {
  const rawFirst = (options?.studentName || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  const greeting = rawFirst ? `Oi, ${rawFirst}!` : 'Oi!';
  const portal = (options?.portalUrl || 'https://system.wisewolflanguage.com.br').trim();

  return `${greeting} Você pode alterar sua forma de pagamento com total segurança diretamente pelo seu Portal do Aluno:

1️⃣ Acesse o portal: ${portal}
2️⃣ Entre no menu *Financeiro* (ou *Mensalidades*)
3️⃣ No bloco *Forma de pagamento*, selecione *Cartão de crédito* e cadastre o seu cartão.

🔒 *Segurança:* Por proteção aos seus dados, nunca envie o número, validade ou código de segurança do seu cartão por mensagem aqui no WhatsApp. No portal, seus dados são transmitidos com criptografia de ponta a ponta direto para a operadora.

💳 O cartão fica salvo automaticamente para as próximas mensalidades e, se houver alguma mensalidade em aberto, ela já é processada na hora!

Se precisar de qualquer ajuda, nossa equipe também já recebeu seu recado e está à disposição por aqui 😊`;
}
