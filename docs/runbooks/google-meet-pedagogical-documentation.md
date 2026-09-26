# Google Meet: documentação pedagógica institucional

Esta integração utiliza uma conta Google central organizadora e o e-mail Google cadastrado de cada professor como coanfitrião.

**Teste real de 26/09/2026 (sala criada pelo servidor, só o coanfitrião com Gmail pessoal entrou, a conta da escola nunca entrou):** conferência registrada; transcrição `FILE_GENERATED` 20 s após a entrada; anotações do Gemini `FILE_GENERATED`; relatório "Relatório de participação em <código> (<data hora>)" no Drive da escola 2 s após o fim. **Não é preciso computador ligado nem a conta central na sala** — o servidor cria a sala e o coanfitrião dispara transcrição, notas e presença. Aulas simultâneas são salas independentes da mesma conta (sem limite documentado; confirmar no primeiro horário com aulas sobrepostas). Com microfone desligado a transcrição sai vazia (`entries` = `{}`).

**Estado em 26/09/2026:** a escola assinou o **Google Workspace Business Plus** sobre o Gmail da conta central (modelo "Workspace no Gmail": sem domínio próprio, painel de administração enxuto, sem ajustes do Meet para ligar). Projeto no Google Cloud `wise-wolf-aulas` ("Wise Wolf Aulas"), APIs **Google Meet REST** e **Google Drive** ativas, cliente OAuth Web "Wise Wolf - servidor (Meet)" com o retorno `https://api.wisewolflanguage.com.br/functions/v1/google-meet`. Sem organização no Cloud, o app OAuth é **Externo** e está **em produção sem verificação** — uso próprio (< 100 usuários): o Google mostra "app não verificado" na conexão (Avançado → continuar) e não expira o token em 7 dias como faria no modo de teste. Não enviar para verificação: exigiria avaliação de segurança por causa do escopo restrito do Drive.
## O que o código implementa

- OAuth com consentimento offline, PKCE S256, nonce aleatório de uso único e expiração em dez minutos. Refresh token e verificador cifrados com AES-GCM e contexto da escola; armazenamento somente privado no servidor.
- Sala exclusiva por sessão, criada pela conta central via `spaces.create`; professor recebe `COHOST` via `spaces.members`. ⚠️ A conta Business Plus **sobre Gmail** recusa `accessType: RESTRICTED` (403 `FEATURE_UNAVAILABLE_TO_USER`, `updateAccessType`); o provider tenta RESTRICTED e, só nesse erro exato, repete com `TRUSTED` — ali equivale ao restrito (sem colegas de domínio: professor entra direto como membro, aluno pede para entrar). Gravação audiovisual fica desligada; o relatório de presença nativo é pedido quando `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED` está ligada. Transcrição e notas são solicitadas automaticamente, sujeitas à edição, configuração e operação do Google.
- Importação de transcrições e smart notes pela conferência da sala. Texto do Google Docs é obtido por `Drive files.export`, apenas para o ID retornado em `docsDestination`. Cada mudança do texto gera uma revisão com hash; não sobrescreve fonte anterior. O filtro usa a janela da agenda para evitar importar reuniões de outros dias no mesmo link.
- Notas nativas aparecem como rascunho. A estruturação adicional via Gemini API é opcional, mostra estimativa em USD, exige reconhecimento do consumo separado e preço cadastrado. Não é incluída automaticamente no AI Pro/Workspace. Gerações são limitadas por sessão; consumo entra em `ai_usage_events`.
- Aprovação humana produz uma nova versão e atualiza `student_learning_memories` com origem `MEET_SESSION`, referência da sessão e versão aprovada. Documentação não altera presença, `class_logs`, scorecards ou folha.
- Processamento periódico a cada 15 minutos, até três sessões por lote: prioriza preparar salas de sessões já materializadas e autorizadas nas próximas 24 horas e importa documentos das aulas encerradas. Configuração pendente do coanfitrião é repetida no máximo uma vez por hora. Uma sessão encerrada é consultada no máximo a cada 30 minutos, durante 28 dias. Sem conexão elegível, configuração completa ou flag ativa, não há chamadas ao Google. Erros ficam na sala e podem ser reprocessados; criação incerta nunca é repetida automaticamente.
- Cópias brutas expiram após o prazo configurado (padrão técnico inicial: 90 dias, ajustável entre 7 e 365). O job diário elimina fontes expiradas. A memória pedagógica e versões de resumo têm finalidade distinta e permanecem; definir a retenção institucional desses derivados antes de escalar.

## Configuração sem compartilhar credenciais

Criar/configurar o aplicativo OAuth da própria escola no Google Cloud (feito em 26/09/2026, ver topo), habilitar Meet REST API e Google Drive API, registrar o redirect exato. Escopos: `openid`, `email`, `meetings.space.created`, `drive.readonly`. Nada de Gmail, agenda ou escrita no Drive.

⚠️ **Por que `drive.readonly` e não `drive.meet.readonly`** (medido em 26/09/2026 na conta central): com `drive.meet.readonly` o servidor **lista** as anotações do Gemini e o relatório de presença e lê os **metadados**, mas `files.export` dá **403 `appNotAuthorizedToFile`** nos dois — repetido 15 min depois, mesmo resultado. Nada da aula seria importado. O código compensa o escopo mais largo abrindo só: o documento cujo id vem da Meet API (`docsDestination`) e planilhas **da própria conta** (`'me' in owners`) criadas na janela da aula, escolhidas pelo código da sala no nome; o plano B (e-mail do professor dentro da planilha) só abre planilha com nome de relatório de presença (`looksLikeAttendanceReport`). Conexão feita com o escopo antigo aparece na tela com aviso "Reconectar conta central".

**O segredo nunca passa pelo chat:** baixar o JSON do cliente (Google Auth Platform → Clientes) e rodar, no computador da direção:

```bash
bash deploy/vps/configurar-google-meet.sh
```

O script lê o `client_secret_*.json` mais novo de Downloads, grava em `/opt/wisewolf/supabase-docker/.env.functions` (600, root) pela entrada padrão do ssh, gera a chave de cifragem **na VPS** se ainda não existir, liga as flags, recria o container das functions e apaga o JSON local. Rodar de novo é seguro (só grava o que mudou; a chave de cifragem existente é preservada).

| Variável | Finalidade |
| --- | --- |
| `GOOGLE_MEET_OAUTH_CLIENT_ID` | ID do aplicativo OAuth Web |
| `GOOGLE_MEET_OAUTH_CLIENT_SECRET` | Segredo do aplicativo OAuth |
| `GOOGLE_MEET_OAUTH_REDIRECT_URI` | URL HTTPS pública exata terminada em `/functions/v1/google-meet` |
| `GOOGLE_MEET_TOKEN_ENCRYPTION_KEY` | 32 bytes aleatórios em base64, gerados na VPS; guardar no backup protegido |
| `GOOGLE_MEET_PEDAGOGY_ENABLED` | `true` liga salas e importação de documentos |
| `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED` | `true` cria a sala com o relatório de presença do Google e importa a planilha (Business Plus) |
| `GOOGLE_MEET_RAW_RETENTION_DAYS` | Retenção das cópias brutas e do relatório de presença, de 7 a 365 dias; ausente = 90 |
| `GOOGLE_MEET_SUMMARY_AI_ENABLED` | `true` para disponibilizar estruturação adicional paga; ausente = desativado |
| `GOOGLE_MEET_SUMMARY_MODEL` | ID do modelo Gemini autorizado; sem modelo não há chamada paga |
| `GEMINI_API_KEY` | Credencial de API Gemini existente, somente se a estruturação adicional for usada |

A chave de cifragem precisa acompanhar o backup dos tokens. Alterá-la sem procedimento de recifragem exige reconectar as contas. Não imprimir valores para diagnosticar problemas; a UI mostra somente os nomes das configurações ausentes.

Na área Google Meet ("Conta central Google"), a direção seleciona "Conectar conta central", abre o link de autorização, escolhe a conta central, passa pelo aviso de app não verificado e permite. Nunca usar a senha central no computador do professor. Conferir o e-mail Google do professor no cadastro; não inferir identidade pelo nome de exibição.

O callback público autentica pelo nonce/PKCE. POSTs autenticam dentro da função; a configuração `verify_jwt=false` é necessária ao callback, não dispensa autorização. Apenas service role pode chamar as funções internas de armazenamento e o job. Não expor o schema `private` na Data API.

## Termo de registro das aulas (autorização permanente)

A sala só é criada e documentada para sessão com `documentation_consent`. Desde a migration `20260926120000`, isso vem de um termo aceito **uma vez**: o aluno maior de idade ou o **responsável** (menor: `is_kids` ou nascimento há menos de 18 anos) responde pelo link `/registro-das-aulas?token=…` (gerado em Qualidade das aulas → "Autorizações de registro", 30 dias, um vivo por aluno), e o **professor** responde no app ("Salas e continuidade"). A cada 15 minutos, o job marca as sessões das próximas 24 h em que os dois aceitaram (evento de consentimento citando o termo) e desmarca as que o próprio termo marcou quando alguém revoga. Decisão manual da escola na sessão prevalece. Só age com a conta Google conectada. O texto do termo (v1, em `private.lesson_recording_terms`) menciona transcrição, anotações e controle de presença; mudar o texto é versão nova, nunca update.

## Lembrete do WhatsApp leva a sala oficial

Desde a migration `20260926190000`, a aula com sala da escola **READY**, sessão viva e aceite vigente (`documentation_consent`) recebe o link da sala em todo aviso ao aluno: o lembrete automático de 30 minutos, o botão "Disparar" do professor e o aviso de reposição marcada. O link entra no `{class_link}` do modelo do professor ou, se o modelo não tem o marcador, numa linha própria no fim: "Esta aula é na sala da escola no Google Meet. Entre por este link:". Aula sem sala segue exatamente como antes (sem link no automático).

- Quem decide é `public.official_lesson_link(tenant, tipo, id, data, professor, hora, aluno)` (só `service_role`), pela ocorrência da agenda (`lesson_occurrences` → `lesson_sessions` → `private.google_meet_rooms`). Agendamento, reposição e antecipação (booking na data nova) valem.
- A sala só vale se a sessão for de quem **dá** a aula: o professor da agenda ou, com cobertura viva do agendamento naquela data, o substituto. Sessão com aceite ou sala fica congelada — cobertura confirmada, reposição com professor trocado ou agendamento transferido depois do aceite não mudam o professor dela, e a sala continua com o coanfitrião antigo. Nesses casos o aviso sai sem a sala (o de sempre), para o aluno não esperar numa sala que só o ausente pode abrir.
- Sala criada para uma aula cujo aceite foi revogado **não** é mandada (a sala transcreve sozinha). Sala em `COHOST_PENDING`/`CREATING`/`NEEDS_RECONCILIATION` também não.
- O texto sai de `public.render_lesson_reminder_message`, o mesmo que a cerca do envio usa para conferir o lembrete. Se a sala ficar pronta (ou deixar de valer) entre a preparação e o envio, a cerca devolve `RETRY` (`official_lesson_room_changed`) e o worker remonta o texto na rodada seguinte — o lembrete não se perde.
- Enquanto 0 salas existirem (estado de 26/09), nenhum aviso muda.

## Presença pelo relatório nativo do Google (Business Plus)

Com `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED=true`, a sala nasce com `attendanceReportGenerationType = GENERATE_REPORT`. No sync, a edge lista as conferências da sala (só nome e horário), procura no Drive da conta central as planilhas criadas pelo Meet até 3 h depois do fim, escolhe a da sala pelo código da reunião no nome (ou, se não houver, pela que cita o e-mail do professor), exporta em CSV e resume professor × aluno × organizador (`attendance.ts`, colunas em português ou inglês). O banco guarda em `private.meeting_attendance_reports` (retenção igual às cópias brutas) e `private.meet_attendance_evaluate` compara com o lançamento:

| Regra | Categoria |
| --- | --- |
| professor entrou 10+ min depois do horário | `LATE_START` |
| lançada como dada e o aluno esteve menos de 5 min | `MEET_ATTENDANCE` (alta) |
| lançada como falta do aluno e ele esteve 10+ min | `MEET_ATTENDANCE` (alta) |
| lançada e o professor esteve menos de 5 min | `MEET_ATTENDANCE` (alta) |
| lançada e a sala da escola nem foi aberta (2 h depois do fim) | `OUTSIDE_ROOM` (baixa) |

**Só sinaliza** (decisão da direção, 26/09/2026): o caso cai na Central de Qualidade com a evidência (minutos e horários) e o texto "não altera o pagamento". Nada muda `class_logs`, folha ou confirmação de presença. A API do Meet **não** é usada para ler participantes. ⚠️ Formato e nome da planilha não são documentados pelo Google: conferir no primeiro relatório real do piloto (e ajustar `attendance.ts` se preciso). Na reunião instantânea da conta central não apareceu opção de presença na interface; a sala criada pela API liga o relatório pela configuração acima.

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

Não há coleta de `participants` ou `participantSessions` pela API do Meet, que o Google declara não se destinar a acompanhamento de desempenho/avaliação de usuários. A presença vem do relatório de presença que o próprio Google oferece no Business Plus e serve para abrir caso de conversa na Central de Qualidade — nunca para descontar, cortar pagamento ou pontuar professor automaticamente.

Fontes oficiais: [spaces.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create), [configuração da sala (attendanceReportGenerationType)](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces), [membros/coanfitrião](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces.members/create), [smartNotes](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.smartNotes), [escopos](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize), [visão geral e limite de uso](https://developers.google.com/workspace/meet/api/guides/overview), [controle de presença](https://support.google.com/meet/answer/10090454), [quando a verificação não é necessária](https://support.google.com/cloud/answer/13464323).
