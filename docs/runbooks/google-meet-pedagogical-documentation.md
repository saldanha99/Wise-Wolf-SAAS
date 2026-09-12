# Google Meet: documentação pedagógica institucional

Esta integração utiliza uma conta Google central organizadora e o e-mail Google cadastrado de cada professor como coanfitrião. A conta Google AI Pro do proprietário não é tratada pelo sistema como prova de elegibilidade para transcrição/coanfitrião: conferir os recursos efetivamente disponíveis antes do piloto. Não comprar licença nem criar contas por este runbook automaticamente.

## O que o código implementa

- OAuth com consentimento offline, PKCE S256, nonce aleatório de uso único e expiração em dez minutos. Refresh token e verificador cifrados com AES-GCM e contexto da escola; armazenamento somente privado no servidor.
- Sala exclusiva por sessão, criada pela conta central via `spaces.create`; professor recebe `COHOST` via `spaces.members`. Gravação audiovisual e relatório de presença ficam desligados. Transcrição e notas são solicitadas automaticamente, sujeitas à edição, configuração e operação do Google.
- Importação de transcrições e smart notes pela conferência da sala. Texto do Google Docs é obtido por `Drive files.export`, apenas para o ID retornado em `docsDestination`. Cada mudança do texto gera uma revisão com hash; não sobrescreve fonte anterior. O filtro usa a janela da agenda para evitar importar reuniões de outros dias no mesmo link.
- Notas nativas aparecem como rascunho. A estruturação adicional via Gemini API é opcional, mostra estimativa em USD, exige reconhecimento do consumo separado e preço cadastrado. Não é incluída automaticamente no AI Pro/Workspace. Gerações são limitadas por sessão; consumo entra em `ai_usage_events`.
- Aprovação humana produz uma nova versão e atualiza `student_learning_memories` com origem `MEET_SESSION`, referência da sessão e versão aprovada. Documentação não altera presença, `class_logs`, scorecards ou folha.
- Processamento periódico a cada 15 minutos, até três sessões por lote: prioriza preparar salas de sessões já materializadas e autorizadas nas próximas 24 horas e importa documentos das aulas encerradas. Configuração pendente do coanfitrião é repetida no máximo uma vez por hora. Uma sessão encerrada é consultada no máximo a cada 30 minutos, durante 28 dias. Sem conexão elegível, configuração completa ou flag ativa, não há chamadas ao Google. Erros ficam na sala e podem ser reprocessados; criação incerta nunca é repetida automaticamente.
- Cópias brutas expiram após o prazo configurado (padrão técnico inicial: 90 dias, ajustável entre 7 e 365). O job diário elimina fontes expiradas. A memória pedagógica e versões de resumo têm finalidade distinta e permanecem; definir a retenção institucional desses derivados antes de escalar.

## Configuração sem compartilhar credenciais

Criar/configurar aplicativo OAuth da própria escola no Google Cloud, habilitar Meet REST API e Google Drive API, registrar o redirect exato e verificar consent screen, usuários de teste, escopos e requisitos aplicáveis de verificação. Usar o menor escopo: `openid`, `email`, `meetings.space.created`, `drive.meet.readonly`. O último é restrito; avaliar a verificação/avaliação exigida para esta distribuição. Não pedir acesso geral ao Gmail, calendário ou Drive.

Configurar exclusivamente nos segredos do runtime da VPS, nunca em `VITE_*`, commits ou logs:

| Variável | Finalidade |
| --- | --- |
| `GOOGLE_MEET_OAUTH_CLIENT_ID` | ID do aplicativo OAuth Web |
| `GOOGLE_MEET_OAUTH_CLIENT_SECRET` | Segredo do aplicativo OAuth |
| `GOOGLE_MEET_OAUTH_REDIRECT_URI` | URL HTTPS pública exata terminada em `/functions/v1/google-meet` |
| `GOOGLE_MEET_TOKEN_ENCRYPTION_KEY` | 32 bytes aleatórios codificados em base64, guardados em cofre e backup protegido |
| `GOOGLE_MEET_PEDAGOGY_ENABLED` | `true` somente depois de validar conta, finalidades e piloto; ausente = desativado |
| `GOOGLE_MEET_RAW_RETENTION_DAYS` | Retenção das novas cópias brutas, de 7 a 365 dias; ausente = 90 |
| `GOOGLE_MEET_SUMMARY_AI_ENABLED` | `true` para disponibilizar estruturação adicional paga; ausente = desativado |
| `GOOGLE_MEET_SUMMARY_MODEL` | ID do modelo Gemini autorizado; sem modelo não há chamada paga |
| `GEMINI_API_KEY` | Credencial de API Gemini existente, somente se a estruturação adicional for usada |

A chave de cifragem precisa acompanhar o backup dos tokens. Alterá-la sem procedimento de recifragem exige reconectar as contas. Não imprimir valores para diagnosticar problemas; a UI mostra somente os nomes das configurações ausentes.

Na área Google Meet, a direção seleciona “Conectar conta central”, abre o link de autorização, escolhe a organizadora e retorna para atualizar o status. Nunca usar a senha central no computador do professor. Conferir o e-mail Google do professor no cadastro; não inferir identidade pelo nome de exibição.

O callback público autentica pelo nonce/PKCE. POSTs autenticam dentro da função; a configuração `verify_jwt=false` é necessária ao callback, não dispensa autorização. Apenas service role pode chamar as funções internas de armazenamento e o job. Não expor o schema `private` na Data API.

## Piloto de aceitação

1. Registrar a autorização aplicável à documentação na sessão. O botão não cria sala nem importa sem esse registro.
2. Criar sala para adultos voluntários/fixtures, com professor Google externo; verificar coanfitrião e início automático sem a matriz presente. Conferir também participante entrando primeiro e mais de uma sala simultânea.
3. Ministrar sessão bilíngue curta e conferir as lacunas de transcrição/notas. Não testar com dados reais de crianças antes do fluxo do responsável estar validado.
4. Importar, reler fontes, revisar objetivo e próximo passo e aprovar. Conferir que outra escola não acessa, que o professor novo autorizado vê a continuidade e que nenhuma presença/pagamento mudou.
5. Repetir importação e confirmar deduplicação; modificar o documento de teste e confirmar nova revisão. Revogar OAuth e observar erro útil e reconexão.
6. Só então ativar em mais sessões, acompanhando capacidade da conta única, retenção, disponibilidade e privacidade dos documentos. Ausência de artefato não comprova falta, atraso ou aula não dada.

## Falhas e recuperação

- `google_permission_or_edition_required`: conferir API habilitada, escopos, edição e políticas Workspace. Não reduzir silenciosamente os controles para passar.
- `COHOST_PENDING`: a sala existe, mas ainda não está pronta. “Concluir configuração da sala” repete apenas a configuração do membro; não cria outra sala.
- `NEEDS_RECONCILIATION`: a chamada de criação ficou sem confirmação. Não há retentativa automática de criação porque o Google não oferece chave de idempotência nessa chamada. A direção técnica precisa conferir a conta organizadora e reconciliar o resultado antes de liberar nova tentativa. Não inventar código de sala.
- `google_organizer_changed`: reconectar a conta que criou a sala para ler seus documentos. Conectar outra conta não concede automaticamente acesso às salas antigas.
- Fonte expirada: ela deixa de ser exibida e não pode sustentar nova aprovação. Histórico derivado aprovado continua identificado pela versão; política de retenção dos derivados precisa ser definida pela escola.
- Desconectar remove o refresh token local e tenta revogar no Google. Se a revogação não for confirmada, a UI orienta conferir conexões de terceiros da conta. Documentos já existentes no Drive não são apagados por esse botão.

## Limite de uso preservado

Não há coleta de `participants` ou `participantSessions`, métricas de presença/duração do provedor, classificação de docente ou decisão financeira nesta implementação. A API do Meet declara não se destinar a acompanhamento de desempenho/avaliação de usuários. Qualquer ampliação depende de validação específica de finalidade com o fornecedor; professores externos não constituem exceção presumida.

Fontes oficiais verificadas na implementação: [spaces.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create), [membros/coanfitrião](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces.members/create), [smartNotes](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.smartNotes), [escopos](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize), [visão geral e limite de uso](https://developers.google.com/workspace/meet/api/guides/overview).
