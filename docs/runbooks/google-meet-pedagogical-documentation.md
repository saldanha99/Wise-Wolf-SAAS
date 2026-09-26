# Google Meet: documentação pedagógica institucional

Esta integração utiliza uma conta Google central organizadora e o e-mail Google cadastrado de cada professor como coanfitrião.

**Teste real de 26/09/2026 (sala criada pelo servidor, só o coanfitrião com Gmail pessoal entrou, a conta da escola nunca entrou):** conferência registrada; transcrição `FILE_GENERATED` 20 s após a entrada; anotações do Gemini `FILE_GENERATED`; relatório "Relatório de participação em <código> (<data hora>)" no Drive da escola 2 s após o fim. **Não é preciso computador ligado nem a conta central na sala** — o servidor cria a sala e o coanfitrião dispara transcrição, notas e presença. Aulas simultâneas são salas independentes da mesma conta (sem limite documentado; confirmar no primeiro horário com aulas sobrepostas). Com microfone desligado a transcrição sai vazia (`entries` = `{}`).

**Estado em 26/09/2026:** a escola assinou o **Google Workspace Business Plus** sobre o Gmail da conta central (modelo "Workspace no Gmail": sem domínio próprio, painel de administração enxuto, sem ajustes do Meet para ligar). Projeto no Google Cloud `wise-wolf-aulas` ("Wise Wolf Aulas"), APIs **Google Meet REST** e **Google Drive** ativas, cliente OAuth Web "Wise Wolf - servidor (Meet)" com o retorno `https://api.wisewolflanguage.com.br/functions/v1/google-meet`. Sem organização no Cloud, o app OAuth é **Externo** e está **em produção sem verificação** — uso próprio (< 100 usuários): o Google mostra "app não verificado" na conexão (Avançado → continuar) e não expira o token em 7 dias como faria no modo de teste. Não enviar para verificação: exigiria avaliação de segurança por causa do escopo restrito do Drive.
## O que o código implementa

- OAuth com consentimento offline, PKCE S256, nonce aleatório de uso único e expiração em dez minutos. Refresh token e verificador cifrados com AES-GCM e contexto da escola; armazenamento somente privado no servidor.
- Sala exclusiva por sessão, criada pela conta central via `spaces.create`; professor recebe `COHOST` via `spaces.members`. ⚠️ A conta Business Plus **sobre Gmail** recusa `accessType: RESTRICTED` (403 `FEATURE_UNAVAILABLE_TO_USER`, `updateAccessType`); o provider tenta RESTRICTED e, só nesse erro exato, repete com `TRUSTED` — ali equivale ao restrito (sem colegas de domínio: professor entra direto como membro, aluno pede para entrar). Gravação audiovisual fica desligada; o relatório de presença nativo é pedido quando `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED` está ligada. Transcrição e notas são solicitadas automaticamente, sujeitas à edição, configuração e operação do Google.
- Importação de transcrições e smart notes pela conferência da sala. Texto do Google Docs é obtido por `Drive files.export`, apenas para o ID retornado em `docsDestination`. Cada mudança do texto gera uma revisão com hash; não sobrescreve fonte anterior. As conferências são procuradas no **dia da aula inteiro** (fuso America/Sao_Paulo), não ±2 h da agenda: a sala é exclusiva da sessão, e aula remarcada por fora no mesmo dia continua sendo a aula (antes virava caso falso de "fora da sala"). Reunião de outro dia no mesmo link fica de fora.
- **Cada documento é importado no seu próprio try/catch** (`importArtifacts`, desde a migration `20260926170000`): falha de um arquivo fica registrada NELE (`private.google_meet_artifact_imports`: `PENDING`/`IMPORTED`/`EMPTY`/`FAILED`, código do erro, tentativas) e aparece em "Sala e resumo" → "Situação dos documentos"; os outros documentos e a presença seguem. Antes, o primeiro export que falhava derrubava a sessão inteira e nem a presença era lida.
- **Documento vazio** (`google_document_empty`, aula sem fala) é `EMPTY`, estado final: nunca é relido nem conta como falha. Documento já importado não é relido pela rodada automática; o botão "Importar transcrição e notas" relê (pega edição do documento), menos o vazio.
- **Plano B da transcrição:** quando o Docs não exporta a transcrição (403, 5xx, sem `docsDestination`, ou `ENDED` há mais de 1 h sem arquivo — por exemplo, Drive da conta sem espaço), o texto é montado pelas falas da API do Meet (`conferenceRecords.transcripts.entries`, paginado), uma linha por fala `[hh:mm:ss] Nome: texto` no fuso da escola, e guardado como fonte `MEET_ENTRIES` do mesmo `TRANSCRIPT`. O nome vem de `participants.get` com máscara `signedinUser(displayName),anonymousUser(displayName),phoneUser(displayName)` — só o rótulo que o próprio documento traria; sem nome, "Participante N". Anotações do Gemini não têm plano B (a API não expõe o texto).
- Notas nativas aparecem como rascunho. A estruturação adicional via Gemini API é opcional, mostra estimativa em USD, exige reconhecimento do consumo separado e preço cadastrado. Não é incluída automaticamente no AI Pro/Workspace. Gerações são limitadas por sessão; consumo entra em `ai_usage_events`.
- Aprovação humana produz uma nova versão e atualiza `student_learning_memories` com origem `MEET_SESSION`, referência da sessão e versão aprovada. Documentação não altera presença, `class_logs`, scorecards ou folha.
- Processamento periódico a cada 15 minutos (`get_pending_google_meet_sync_sessions`, até 30 trabalhos): a edge processa **enquanto houver tempo** — começa trabalho novo até ~100 s e dá a cada importação o prazo de ~125 s para parar de abrir documentos (o worker morre em 150 s); o que sobra fica para a rodada seguinte. Prioridade: 0) sala para aula nas próximas 3 h; 1) **primeira importação depois do fim da aula**; 2) sala para aula mais distante (até 24 h); 3) re-consulta de importação pendente. Um token de acesso por escola por rodada. Configuração pendente do coanfitrião é repetida no máximo uma vez por hora. Sem conexão elegível, configuração completa ou flag ativa, não há chamadas ao Google.
- **A fila tem fim** (`google_meet_rooms.sync_status`): `WAITING` → `PENDING` → `COMPLETE` quando tudo que o Google gerou foi importado (ou é vazio) **e**, com a presença ligada, o relatório foi lido e avaliado contra uma aula **já lançada** (lançamento que chega depois ainda precisa ser comparado). Sem conclusão, volta em 10 min nas primeiras 6 h depois da aula, de hora em hora até 48 h e a cada ~6 h até **7 dias** — aí `EXPIRED`. Sala sem nenhum documento (aula que não usou a sala) não conclui antes da janela, para a regra "fora da sala" poder rodar depois do fim do dia.
- **Sala que o Google não criou vira `FAILED`** e é tentada de novo sozinha: 30 min, 2 h, 6 h, 6 h; na 5ª a rodada automática desiste e a tela oferece "Tentar criar a sala de novo" (o clique não espera). Vale para recusa (403/400) e para falha incerta (rede, 5xx, timeout): nos dois casos **nenhum link foi salvo**, e só o link salvo chega ao aluno e ao professor — um space criado no Google e não salvo aqui fica órfão na conta da escola, sem ninguém com o link. Reserva presa em `CREATING` há mais de 15 min (o worker morreu) também é retomada. A reserva (`claim_id`) garante que só uma tentativa grava o link: worker atrasado recebe `google_room_claim_lost` e o space dele nunca é distribuído.
- **Token:** só `invalid_grant`/`unauthorized_client` (token revogado, expirado, senha trocada ou emitido para outro cliente OAuth) marcam a conta como `REAUTH_REQUIRED`. 5xx, 429 e erro de rede são transitórios (`google_oauth_unavailable`) e não desconectam; `invalid_client` (segredo trocado) é `google_oauth_rejected` — configuração, não reconexão.
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

## Presença pelo relatório nativo do Google (Business Plus)

Com `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED=true`, a sala nasce com `attendanceReportGenerationType = GENERATE_REPORT`. No sync, a edge lista as conferências da sala (só nome e horário), procura no Drive da conta central as planilhas criadas pelo Meet até 3 h depois do fim, escolhe a da sala pelo código da reunião no nome (ou, se não houver, pela que cita o e-mail do professor), exporta em CSV e resume professor × aluno × organizador (`attendance.ts`, colunas em português ou inglês). O banco guarda em `private.meeting_attendance_reports` (retenção igual às cópias brutas) e `private.meet_attendance_evaluate` compara com o lançamento:

| Regra | Categoria |
| --- | --- |
| professor entrou 10+ min depois do horário | `LATE_START` |
| lançada como dada e o aluno esteve menos de 5 min | `MEET_ATTENDANCE` (alta) |
| lançada como falta do aluno e ele esteve 10+ min | `MEET_ATTENDANCE` (alta) |
| lançada e o professor esteve menos de 5 min | `MEET_ATTENDANCE` (alta) |
| lançada e a sala da escola nem foi aberta no dia (2 h depois do fim **e** depois que o dia da aula acabou) | `OUTSIDE_ROOM` (baixa) |

Desde `20260926170000`: atraso só conta se o professor entrou **antes do fim previsto** (entrar depois é aula remarcada, não atraso), e "fora da sala" espera o dia acabar — a busca cobre o dia todo e a aula remarcada para a tarde ainda pode acontecer. **Queda e reentrada** geram uma planilha por conferência, todas com o código da sala no nome: entram todas, e as linhas da mesma pessoa são juntadas (primeira entrada, última saída, soma das durações — `mergeAttendanceRows`); o registro guarda os ids em `source_document_ids`. Com todas as planilhas do dia já guardadas, a rodada seguinte só reavalia contra o lançamento, sem baixar de novo.

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
- `FAILED`: o Google recusou ou não confirmou a criação. A tela mostra o motivo e o horário da próxima tentativa automática; enquanto isso a aula usa o link de sempre (`get_my_lesson_rooms` não devolve a sessão). Depois de 5 tentativas, só pelo botão.
- `NEEDS_RECONCILIATION`: só sobra para o caso de **dois links** para a mesma aula (chegou um segundo `space_name` para uma sala que já tinha link salvo — `google_room_space_conflict`). A direção escolhe qual vale; enquanto isso a aula usa o link de sempre. Linha antiga nesse estado **sem** link (regra anterior de "criação incerta") é retomada sozinha depois de 15 min. Não inventar código de sala.
- Documento `FAILED` em "Situação dos documentos": o motivo aparece por arquivo (`google_document_permission_required` = a conta da escola não abre o arquivo; conferir escopo `drive.readonly` e reconectar). A transcrição tenta o plano B pelas falas; a anotação é tentada de novo na próxima importação.
- `google_oauth_unavailable`: o Google não respondeu na troca de token. Nada a fazer; a próxima rodada tenta. Não reconectar por isso.
- `google_organizer_changed`: reconectar a conta que criou a sala para ler seus documentos. Conectar outra conta não concede automaticamente acesso às salas antigas.
- Fonte expirada: ela deixa de ser exibida e não pode sustentar nova aprovação. Histórico derivado aprovado continua identificado pela versão; política de retenção dos derivados precisa ser definida pela escola.
- Desconectar remove o refresh token local e tenta revogar no Google. Se a revogação não for confirmada, a UI orienta conferir conexões de terceiros da conta. Documentos já existentes no Drive não são apagados por esse botão.

## Limite de uso preservado

Não há coleta de `participantSessions` nem de horários de participantes pela API do Meet, que o Google declara não se destinar a acompanhamento de desempenho/avaliação de usuários. A única leitura de `participants` é o **nome de exibição** de quem falou, com máscara de campos, para rotular a transcrição do plano B — o mesmo rótulo que o documento do Google traria. A presença vem do relatório de presença que o próprio Google oferece no Business Plus e serve para abrir caso de conversa na Central de Qualidade — nunca para descontar, cortar pagamento ou pontuar professor automaticamente.

Fontes oficiais: [spaces.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create), [configuração da sala (attendanceReportGenerationType)](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces), [membros/coanfitrião](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces.members/create), [smartNotes](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.smartNotes), [escopos](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize), [visão geral e limite de uso](https://developers.google.com/workspace/meet/api/guides/overview), [controle de presença](https://support.google.com/meet/answer/10090454), [quando a verificação não é necessária](https://support.google.com/cloud/answer/13464323).
