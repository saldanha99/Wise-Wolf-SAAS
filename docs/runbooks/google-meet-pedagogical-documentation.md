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

A sala só é criada e documentada para sessão com `documentation_consent`. Desde a migration `20260926120000`, isso vem de um termo aceito **uma vez**: o aluno maior de idade ou o **responsável** responde pelo link `/registro-das-aulas?token=…` (gerado em Qualidade das aulas → "Autorizações de registro", 30 dias, um vivo por aluno), e o **professor** responde no app ("Salas e continuidade"). A cada 15 minutos, o job marca as sessões das próximas 24 h em que os dois aceitaram (evento de consentimento citando o termo) e desmarca as que o próprio termo marcou quando alguém revoga ou quando o aceite deixa de valer. Decisão manual da escola na sessão prevalece. Só age com a conta Google conectada. O texto do termo (em `private.lesson_recording_terms`, versão vigente = a publicada por último) menciona transcrição, anotações e controle de presença; mudar o texto é versão nova, nunca update.

### Lado do aluno e do responsável (migration `20260926200000`)

Medido em 26/09/2026: 47 de 47 alunos ativos sem `birth_date` e sem `is_kids`. Na regra anterior todos pareciam adultos e qualquer pessoa com o link aceitava "como aluno" digitando um nome. Agora (decisões da direção):

- **Idade desconhecida = responsável (fail-closed).** `private.lesson_recording_guardian_reason` devolve `KIDS` (turma infantil), `MINOR` (menor pela data da escola) ou `AGE_UNKNOWN` (sem data atestada); nulo só para adulto comprovado. Aluno inexistente também exige responsável.
- **A data de nascimento que vale é a cadastrada pela escola.** `set_student_birth_date(aluno, data, motivo)` — SCHOOL_ADMIN ou COORDINATOR da escola (`can_manage_lesson_quality`), grava `profiles.birth_date` e uma linha em `private.student_birth_date_records`. A prova só vale enquanto a última linha bate com o cadastro: data trocada por outro caminho (formulário de matrícula, o próprio aluno pela API) faz o aluno voltar a `AGE_UNKNOWN` até a escola confirmar de novo. Nunca é digitada no link público. Tela: campo "Data de nascimento (confirmada pela escola)" na edição do aluno (`StudentBirthDateField`, direção/coordenação) e botão "Cadastrar data de nascimento" no painel de autorizações para quem está `AGE_UNKNOWN`.
- **Trilha:** `log_profile_changes` passou a gravar `birth_date`, `is_kids` e `guardian_phone` de aluno em `profile_audit_log`; a confirmação de uma data que já estava no cadastro entra como `birth_date_confirmed`.
- **Turma infantil (`is_kids`) é da direção.** O professor não muda o campo pela RPC `update_student_pedagogical_profile` (erro `kids_classification_requires_direction`; mandar o mesmo valor continua salvando o resto) nem direto pela API (`enforce_profile_authorization_fields`). As telas do professor deixaram de mandar o campo.
- **Código de 6 dígitos pelo WhatsApp antes de gravar qualquer decisão** (aceite ou recusa). A página chama a edge **`lesson-recording-code`** (pública, autenticada pelo token do link), que pede o código a `issue_lesson_recording_consent_code` (só service_role), manda pela instância central da escola com `sendWhatsTextDetailed` (pede licença ao `whatsapp_outbound_permit`; destino aluno/responsável = `transactional`) e registra o resultado em `settle_lesson_recording_consent_code`. O banco guarda só `sha256(id do desafio || ':' || código)`; o código não volta ao navegador nem vai para log. Vale 10 minutos, 5 tentativas (a 5ª errada invalida), 3 envios por hora por link (envio que não saiu — teto do WhatsApp, recusa — não conta; resposta incerta conta). Um código só decide depois de confirmado o envio, e um reenvio que não saiu não mata o código anterior.
- **Para qual telefone:** o do cadastro **no momento em que a escola gerou o link** (snapshot em `lesson_recording_consent_links.student_phone/guardian_phone`): contato verificado em `student_quality_contacts` → `profiles.phone`/`attendance_phone` (aluno) ou `guardian_phone` → telefone do perfil do responsável financeiro (responsável). Corrigiu o telefone? Gere um link novo. Assim o aluno que troca o próprio "telefone do responsável" depois do link não recebe o código no lugar dele.
- **O que fica registrado:** `lesson_recording_consents.verification = 'WHATSAPP_CODE'`, `verified_phone` mascarado ("(11) •••••-1234") e o id do desafio. Uma constraint (`NOT VALID`, vale para linha nova) recusa decisão pelo link sem isso. A rota antiga `decide_lesson_recording_consent_public(text,text,text,boolean)` foi derrubada; a nova recebe o código como 5º argumento.
- **O que vale para marcar aula** (`private.lesson_recording_student_consent_effective`): última decisão do aluno é aceite com código e, se hoje o cadastro exige responsável, dado pelo responsável. Aceite "como aluno" deixa de valer se a escola registrar depois que é menor; o job desmarca as sessões que o termo tinha marcado. Aceite pelo link anterior a esta migration (sem código) não vale — em 26/09 não havia nenhum.
- **Painel da escola** mostra o motivo do responsável, o telefone que recebe o código, o telefone confirmado e o aviso "este aceite não vale" quando for o caso. O contador de "alunos autorizaram" conta só aceite que vale.

Diagnóstico: `ssh wisewolf-vps 'docker logs supabase-edge-functions --since 1h | grep lesson-recording-code'` e `select delivery_status, count(*) from private.lesson_recording_consent_challenges where created_at > now() - interval '1 day' group by 1`. Suítes: `supabase/tests/termo_seguro_do_aluno.sql` e `termo_de_registro_das_aulas.sql`.

### Conta Google do professor antes do aceite

O cartão "Registro das suas aulas" (`LessonRecordingTeacherCard`) pede ao professor que confirme por login Google a conta que entra como coanfitriã (`googleMeetAction('teacher_identity_connect')` devolve a URL de autorização, aberta em outra aba; `get_my_google_identity()` devolve `{email, verified_at}`). Sem identidade confirmada o botão "Li e autorizo" fica desligado; recusar e revogar continuam disponíveis. Se a RPC de identidade ainda não existir no banco, o cartão mostra "Confirmação de conta Google indisponível" e segue sem quebrar. O servidor pode recusar o aceite com `teacher_google_identity_required`, que a tela explica. O backend dessa confirmação é da frente da identidade do professor (fora desta migration).

### Envio do termo em lote (migration `20260926210000`)

Em "Autorizações de registro", a direção (SCHOOL_ADMIN; coordenação só vê) clica em **"Enviar termo aos alunos pendentes"**, confere na própria tela quantas mensagens saem, quantas vão ao responsável, quantos ficam sem contato e de quando a quando o lote sai, e só então confirma. **Nada é enviado no deploy.**

- **Quem entra:** aluno ativo (lifecycle `active`, `is_student_notifiable`, membership STUDENT ativa, sem `is_test_account`) sem decisão na versão vigente e sem pedido desta versão. Quem **recusou ou teve a autorização revogada não recebe pedido de novo**; quem aceitou versão anterior recebe o texto novo com a frase "o termo foi atualizado". Até 60 por clique.
- **Para quem vai:** menor de idade **ou idade não cadastrada** → responsável (contato verificado `GUARDIAN` em `student_quality_contacts`, depois `profiles.guardian_phone`, depois o perfil de `guardian_id`). Sem telefone do responsável o aluno aparece como **sem contato** com o que falta cadastrar — o termo nunca vai ao número de quem pode ser menor. Adulto: contato verificado `STUDENT`, depois `attendance_phone`, depois `phone`.
- **Fila:** `notification_queue`, kind `LESSON_RECORDING_CONSENT_REQUEST`, `idempotency_key = lesson-recording-consent:<aluno>:<versão>:<tentativa>`, só pela instância central (`queueAudience` → `centralOnly`). Pedido registrado em `private.lesson_recording_consent_requests` (link, destino, hash da mensagem, quem pediu).
- **Espaçamento:** uma mensagem a cada 3 minutos (no máximo 5 em qualquer janela de 15 min), só de segunda a sábado, das 9h às 20h de Brasília; lote novo começa 3 min depois do último pedido ainda na fila. O processador ainda pede licença a `whatsapp_outbound_permit` e adia sem gastar tentativa.
- **Revalidação na hora de mandar** (`get_lesson_recording_consent_request_snapshot`, service role): respondeu, revogou, deixou de ser ativo, mudou de contato, teve o link substituído ("Gerar link novo" revoga o do lote), mensagem alterada na fila, termo mudou de versão ou avisos a alunos desligados → a mensagem é cancelada (`skipped`) com o motivo, sem nova tentativa.
- **Reenviar:** liberado 3 dias depois do último envio que saiu (ou ficou incerto); mensagem que não saiu pode ser reenviada na hora. O lote e o reenvio não revogam o link anterior (pode ter sido mandado à mão).
- **Aberto?** `get_lesson_recording_consent_public` passou a gravar `first_opened_at`/`last_opened_at` no link (deixou de ser `STABLE`). ⚠️ Quem recriar essa função precisa manter a chamada a `private.lesson_recording_note_link_opened` — o teste `termo_de_registro_envio_em_lote.sql` reprova sem ela.
- **Medido em 26/09/2026:** 46 alunos ativos na Wise Wolf, **0 com data de nascimento**, 0 marcados como kids, 1 com telefone de responsável. Pela regra acima, só 1 recebe até a escola cadastrar a data de nascimento (ou o telefone do responsável) — a lista "Sem contato" mostra quem falta.

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
3. Ministrar sessão bilíngue curta e conferir as lacunas de transcrição/notas. Não testar com dados reais de crianças antes do fluxo do responsável estar validado ponta a ponta (link → código no WhatsApp do responsável → aceite com `verification = 'WHATSAPP_CODE'`), com um aluno fixture cujo "responsável" seja um telefone da equipe.
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
