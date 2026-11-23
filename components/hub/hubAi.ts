import { supabase } from '../../lib/supabase';

// Chamada única às ações de IA do Hub na edge `pedagogical-content`
// (material, ferramentas, CEFR e adaptação). O erro volta como código; a tela
// traduz com `hubAiErrorMessage`.

export class HubAiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function invokeHubAi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke<unknown>('pedagogical-content', {
    body: { hubMode: true, requestKey: crypto.randomUUID(), ...body },
  });
  let payload = data as Record<string, unknown> | null;
  if (error) {
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      payload = await response.json().catch(() => null);
    }
    if (!payload || (!payload.error && !payload.code)) throw new HubAiError('NETWORK');
  }
  if (!payload) throw new HubAiError('EMPTY');
  const code = typeof payload.code === 'string' ? payload.code : typeof payload.error === 'string' ? payload.error : '';
  if (code) throw new HubAiError(code);
  return payload;
}

const MESSAGES: Record<string, string> = {
  USAGE_LIMIT_REACHED: 'Você usou toda a cota desta ferramenta no período. Escolha um plano maior para continuar.',
  FEATURE_NOT_INCLUDED: 'Esta ferramenta não está incluída no seu plano atual.',
  SUBSCRIPTION_REQUIRED: 'Seu teste terminou. Escolha um plano para continuar.',
  AI_PROVIDER_INVALID_RESPONSE: 'A IA não entregou o resultado dentro do padrão. Nada foi cobrado — tente de novo.',
  AI_PROVIDER_UNAVAILABLE: 'A IA está indisponível agora. Tente de novo em instantes; nada foi cobrado.',
  MATERIAL_TOPIC_REQUIRED: 'Descreva o tema (mínimo 3 caracteres).',
  MATERIAL_SOURCE_TEXT_REQUIRED: 'Cole um texto em inglês com pelo menos 30 palavras.',
  INVALID_MATERIAL_COUNT: 'Escolha entre 4 e 15 itens.',
  INVALID_HUB_TOOL: 'Ferramenta desconhecida. Recarregue a página.',
  HUB_ACCESS_UNAVAILABLE: 'Não foi possível confirmar seu acesso. Recarregue a página e tente de novo.',
  AI_DISABLED_FOR_TEST_FIXTURE: 'Conta de teste: IA desativada.',
  CEFR_TEXT_TOO_SHORT: 'Cole um texto com pelo menos 15 palavras.',
  URL_INVALID: 'Esse link não é válido. Copie o endereço completo da página (começa com https://).',
  URL_SCHEME_NOT_ALLOWED: 'Só aceitamos links de páginas da web (http ou https).',
  URL_HOST_NOT_ALLOWED: 'Esse endereço não pode ser aberto pelo Hub.',
  URL_PORT_NOT_ALLOWED: 'Esse endereço não pode ser aberto pelo Hub.',
  URL_CREDENTIALS_NOT_ALLOWED: 'Tire usuário e senha do link.',
  URL_HOST_UNRESOLVED: 'Não encontramos esse site. Confira o link.',
  URL_TIMEOUT: 'A página demorou demais para abrir. Tente de novo ou cole o texto.',
  URL_TOO_LARGE: 'A página é grande demais. Cole só o trecho que você quer usar.',
  URL_CONTENT_TYPE_NOT_ALLOWED: 'Esse link não é uma página de texto (PDF, vídeo ou imagem). Cole o texto ou use um print.',
  URL_NO_READABLE_TEXT: 'Não achamos texto suficiente nessa página (pode exigir login). Cole o texto ou use um print.',
  URL_FETCH_FAILED: 'Não conseguimos abrir essa página. Cole o texto ou use um print.',
  URL_TOO_MANY_REDIRECTS: 'Essa página redireciona demais. Cole o texto ou use um print.',
  IMAGE_INVALID: 'Envie uma imagem JPG, PNG ou WebP.',
  IMAGE_TOO_LARGE: 'A imagem passou de 5 MB. Recorte o print e tente de novo.',
  IMAGE_NO_READABLE_TEXT: 'Não achamos texto em inglês legível no print. Nada foi cobrado.',
};

export function hubAiErrorMessage(error: unknown, fallback = 'Não foi possível concluir agora. Tente de novo.'): string {
  const code = error instanceof Error ? error.message : '';
  if (code.startsWith('URL_HTTP_')) return 'A página respondeu com erro. Confira o link ou cole o texto.';
  return MESSAGES[code] || fallback;
}
