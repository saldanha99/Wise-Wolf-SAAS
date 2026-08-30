# Caixa de entrada do WhatsApp

## Objetivo

A caixa de entrada é uma interface nativa do sistema para acompanhar e responder
as conversas do número institucional da escola. Ela não incorpora o WhatsApp Web
e não expõe a chave da Evolution API ao navegador.

O histórico visível no painel é uma cópia canônica e auditável no Supabase. A
carga inicial vem dos endpoints `findChats` e `findMessages` da Evolution; depois
disso, o webhook já usado pelos agentes mantém as conversas atualizadas.

## Privacidade e habilitação

- A sincronização começa desabilitada em toda instância.
- Um administrador deve confirmar explicitamente que o número é institucional.
- Somente uma instância pertencente a um `SCHOOL_ADMIN` ativo pode ser habilitada.
- Instâncias pessoais de professor nunca podem ser sincronizadas na caixa da escola.
- Conversas e mensagens possuem `tenant_id`, RLS e leitura limitada aos papéis de
  gestão autorizados no tenant ativo.
- O navegador tem somente permissão de leitura. Sincronização, envio, leitura e
  handoff passam pela Edge Function autenticada.

Desabilitar a caixa interrompe a exposição e as operações do painel, mas não
remove o webhook da instância: os agentes da escola também dependem dele.

## Fluxo de dados

1. Ao habilitar, o backend configura o único webhook permitido pela Evolution
   para o receptor `whatsapp-inbound`, com segredo em header HTTP.
2. A sincronização inicial importa os chats recentes e, ao abrir uma conversa, o
   histórico disponível na Evolution.
3. Cada webhook é sanitizado e gravado em um ledger durável antes de qualquer
   processamento demorado dos agentes.
4. Mensagens são deduplicadas por tenant, instância e ID do provedor.
5. A tela lê as tabelas protegidas e recebe alterações pelo Supabase Realtime.
6. Um envio manual cria primeiro uma saída idempotente no banco e ativa o handoff
   humano por 72 horas; só então o backend chama a Evolution.

## Estados de envio

- `queued`: pedido registrado, ainda sem tentativa no provedor.
- `dispatching`: chamada externa iniciada.
- `sent`, `delivered` e `read`: confirmação progressiva do provedor.
- `failed`: rejeição conhecida; o usuário pode tentar novamente com um novo pedido.
- `uncertain`: houve timeout depois do início do envio. O sistema não repete
  automaticamente, pois a mensagem pode ter sido aceita e a repetição a duplicaria.

O `client_request_id` impede que dois cliques ou a repetição da mesma requisição
criem dois envios.

## Handoff entre humano e IA

Ao enviar pela caixa ou clicar em **Assumir atendimento**, a conversa passa para
modo humano por 72 horas. O mesmo estado é refletido nos leads e candidaturas que
usam aquele telefone, impedindo que a IA responda ao mesmo tempo. O gestor pode
devolver a conversa à IA a qualquer momento.

## Limitações conhecidas da sincronização

- `findChats` e `findMessages` consultam o banco local da Evolution; eles não
  recuperam arbitrariamente tudo o que já existiu no telefone.
- A carga inicial do piloto limita a quantidade por página para caber no tempo de
  execução da Edge Function. Conversas são enriquecidas sob demanda ao serem abertas.
- Texto é o primeiro formato enviável pelo painel. Mídias recebidas aparecem com
  tipo e legenda/transcrição quando disponíveis; download seguro fica para uma fase
  posterior.
- A contagem de não lidas é calculada no nosso banco, e não copiada da Evolution.

## Configuração operacional

Variáveis obrigatórias nas Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_INBOUND_TOKEN`
- `WHATSAPP_INBOUND_PUBLIC_URL` com a URL HTTPS exata
  `/functions/v1/whatsapp-inbound` (na VPS, não use o `SUPABASE_URL` interno)
- credenciais da Evolution resolvidas pelo broker de integração do tenant

Ordem de publicação:

1. aplicar a migration da inbox;
2. publicar `whatsapp-inbound` e `whatsapp-evolution-proxy`;
3. atualizar o webhook com a lista expandida de eventos;
4. habilitar a instância institucional pela interface;
5. executar **Sincronizar** e validar entrada, resposta, handoff e troca de tenant.

Durante a primeira publicação, o receptor aceita tanto o novo header
`x-whatsapp-inbound-token` quanto o parâmetro legado `?token=` para não interromper
instâncias já conectadas. O parâmetro legado não é registrado. Depois de inventariar
e reconfigurar todas as instâncias para o header, remova essa compatibilidade em uma
segunda publicação e rotacione o token, pois URLs antigas podem existir em logs de
infraestrutura.

Nunca registrar o campo `apikey`, URLs assinadas de mídia, tokens, headers ou o
payload bruto não sanitizado. A consulta de configuração do webhook pode devolver
o segredo e também não deve ser impressa em logs.
