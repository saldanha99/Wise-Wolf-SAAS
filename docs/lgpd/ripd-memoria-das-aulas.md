# RIPD — Memória das aulas (registro das aulas no Google Meet, resumo por IA, dossiê e cartão do aluno)

> ## ⚠️ RASCUNHO PARA REVISÃO JURÍDICA
>
> Este documento é um **rascunho técnico** do Relatório de Impacto à Proteção de Dados Pessoais
> (art. 5º, XVII, e art. 38 da LGPD), escrito pela equipe de produto a partir do que o código faz em
> 27/09/2026. **Não é parecer jurídico.** As bases legais estão marcadas como **propostas**; riscos,
> prazos e textos ao titular precisam de revisão e aprovação do jurídico da escola antes de valer.
> Citações de resoluções da ANPD estão indicadas "a confirmar" quando o número ou o alcance devem ser
> conferidos pelo jurídico.

## 1. Identificação

| Papel | Quem | Observação |
| --- | --- | --- |
| **Controlador** | A escola (cada escola cliente da plataforma é controladora dos dados dos próprios alunos e professores). | No termo, a escola é identificada por marcadores preenchidos com os dados que ela mesma cadastra em Configurações → Escola e legal: `{escola_nome}` (razão social), `{escola_documento}` (CNPJ) e `{escola_contato_privacidade}` (encarregado e e-mail de privacidade). Nenhum dado de escola fica no código. |
| **Encarregado (DPO)** | Indicado pela escola em Configurações → Escola e legal ("Encarregado de dados (LGPD)" e "Contato de privacidade (LGPD)"). | Sem cadastro, o termo diz "a direção da escola, pelo WhatsApp da escola" e o painel da direção avisa o que falta. Ver pendência J4. |
| **Operador — plataforma** | Fornecedor da plataforma Wise Wolf (software e hospedagem em servidor próprio — VPS). | O suporte técnico da plataforma (`SUPER_ADMIN`) lê o resumo aprovado e o cartão do aluno de qualquer escola (não a transcrição bruta); o termo v3 diz isso e lista o "fornecedor do sistema" entre quem processa. Contrato entre plataforma e escola deve prever papel de operador (pendência J6). Confirmar o país do servidor para o §6. |
| **Operador — Google** | Google Workspace (Business Plus) da escola: sala do Meet, transcrição, anotações automáticas (Gemini), relatório de presença, Drive. | Conta central da escola; app OAuth próprio da escola. |
| **Operador — IA** | Provedor de IA contratado pela escola: **OpenRouter** (roteia para modelos de terceiros), serviço pago, com uso dos dados para treino desligado. | Resumo automático, sugestões de planejamento e de cartão. Confirmar configuração e contrato (pendência J3). A estruturação opcional pela API Gemini (`GOOGLE_MEET_SUMMARY_AI_ENABLED`) segue desligada por padrão. |
| **Suboperadores de mensagem** | Provedor do WhatsApp da escola (Evolution API) para o código de 6 dígitos e o envio do termo. | Só telefone, primeiro nome e o texto da mensagem. |

## 2. Titulares

1. **Aluno maior de idade** — só é tratado como adulto quando a **escola** atesta a data de nascimento (`set_student_birth_date`, migration `20260926200000`). Idade desconhecida = menor (fail-closed).
2. **Aluno menor de idade** (criança e adolescente, art. 14 LGPD) — turma infantil (`is_kids`), menor pela data atestada, ou idade não comprovada.
3. **Responsável legal** — quem decide pelo menor; nome digitado, telefone (atestado pela escola) e evidências do aceite.
4. **Professor** — em geral **prestador PJ/MEI**, não empregado. Conta Google confirmada por login, voz/fala na aula, horários de entrada e saída.
5. **Coordenação e direção** — como autores de ações (revisão, marcação manual, revogação registrada).
6. **Terceiros ocasionais na sala** (convidado, familiar que aparece na chamada) — nome de exibição e fala, se houver.

## 3. Dados tratados (categorias)

| Categoria | Exemplos | Onde fica | Prazo no sistema |
| --- | --- | --- | --- |
| Identificação e contato | nome, e-mail da conta Google do professor, telefone do aluno/responsável | `profiles`, `private.teacher_google_identities`, links do termo | enquanto durar a relação |
| **Conteúdo da aula** | transcrição (fala convertida em texto), anotações automáticas do Gemini | `private.meeting_artifact_revisions` (cópia) e Drive da escola (original) | cópia: 90 dias da importação; original: apagado 90 dias depois da aula (lixeira do Google; ver §7) |
| Presença | horário de entrada e saída de cada participante, minutos | `private.meeting_attendance_reports` | 90 dias |
| Trechos da aula no resumo | `narrative` (no rascunho nativo, as anotações do Google na íntegra; no aprovado, o que o professor manteve) e `evidence` (citações literais da transcrição) | `private.lesson_summary_versions` | 90 dias depois da aula, no rascunho **e** no aprovado |
| Derivados pedagógicos | resumo (objetivo, conteúdos, dificuldades, tarefa, próximo passo), memória do aluno | `private.lesson_summary_versions`, `public.student_learning_memories` (`MEET_SESSION`) | enquanto estudar + 90 dias depois de sair |
| Preferências pedagógicas | cartão do aluno: objetivo, temas, estilo de correção, "o que evitar", observações | `public.student_learning_cards` | enquanto estudar + 90 dias depois de sair |
| Sugestões da IA para o cartão | item sugerido (objetivo, tema, estilo de correção, "o que evitar") e a frase literal da aula que o sustenta | `private.student_card_suggestions` (e o custo, sem texto, em `private.student_card_suggestion_runs`) | texto só até o professor decidir; a frase da aula no máximo 90 dias depois da aula; decidida, fica só o hash do valor (sem sal — reversível por dicionário para palavras curtas) e quem decidiu, por 90 dias, e a linha some; tudo apagado 90 dias depois de o aluno sair ou na exclusão a pedido |
| Evidências de consentimento | nome digitado, relação (aluno/responsável), data/hora, IP, navegador, telefone mascarado que recebeu o código, versão do termo | `private.lesson_recording_consents` | não expira (prova do aceite e da revogação) — pendência J7 |
| Registros de acesso | quem leu a documentação de qual aula | `private.google_meet_access_events` | sem prazo definido — pendência J7 |
| Trilha de retenção | só contagens por escola e rodada | `private.lesson_memory_retention_runs` | sem prazo (não há dado pessoal) |

**Dados sensíveis (art. 5º, II, e art. 11):** o sistema **não coleta** de propósito, mas a transcrição pode captar, por acaso, fala sobre saúde, religião, política, família ou dinheiro. O cartão do aluno proíbe esses temas (texto do termo, aviso na tela, limites de tamanho) e, para menor, guarda só interesses pedagógicos. As sugestões da IA para o cartão (`20260928130000`) têm barreira no servidor: o prompt proíbe os temas e uma lista de termos — na edge e de novo no banco — descarta a sugestão cujo valor ou frase da aula fale de saúde, religião, política, família, dinheiro, orientação sexual, origem étnica, sindicato, outras pessoas ou identificadores; para menor, a IA só pode sugerir objetivo e temas. A lista é por palavras: reduz, não elimina, o risco — por isso nada entra no cartão sem o aceite do professor.

## 4. Finalidades e bases legais **propostas** (para revisão do jurídico)

| # | Finalidade | Base proposta | Observação para o jurídico |
| --- | --- | --- | --- |
| F1 | Registrar a aula (transcrição e anotações) para continuidade pedagógica | Consentimento (art. 7º, I); menor: consentimento específico e em destaque de um dos pais/responsável (art. 14, §1º) | Vale para as escolas no **aceite individual**. No **registro autorizado pela escola** (Wise Wolf desde 27/09/2026) as bases propostas são outras, por grupo — ver §4.1. Avaliar o Enunciado CD/ANPD nº 1/2023 sobre bases para dados de crianças e adolescentes (a confirmar). |
| F2 | Resumo automático por IA, revisado e aprovado pelo professor | Consentimento (F1), com a IA descrita no termo v3 | Transferência internacional (§6). Não há decisão automatizada com efeito sobre o titular (art. 20): o resumo só entra na ficha depois da aprovação humana. |
| F3 | Planejar próxima aula e tarefa com IA a partir do resumo aprovado | Consentimento (F1) / execução do contrato educacional | Usa só o resumo aprovado e o cartão. |
| F4 | Dossiê para o novo professor ou substituto (link com login) | Execução do contrato educacional (art. 7º, V) ou legítimo interesse | Acesso limitado a quem vai dar a aula; transcrição bruta fica fora. |
| F5 | Cartão do aluno (sugestões da IA revisadas pelo professor) | Consentimento (F1) / legítimo interesse | Nunca dados sensíveis; menor só interesses pedagógicos. |
| F6 | Confirmar que a aula aconteceu (relatório de presença) | Legítimo interesse (art. 7º, IX) com teste de balanceamento, ou execução do contrato com o professor | **Só sinaliza** caso na Central de Qualidade; não altera pagamento (decisão da direção). |
| F7 | Extrato de pontualidade do professor (sem nota, sem ranking, visível a ele) | Legítimo interesse, **só depois do parecer** | Construído e desligado por escola até o jurídico decidir (risco R2; migration `20260928120000`). Desligado, nada é calculado. Ligado: só números do professor (entrada, minutos na sala, atraso, saída antecipada, motivo da falta de medição), sem dado do aluno; o professor vê o dele, direção e coordenação um professor por vez; 90 dias depois da aula (o prazo do relatório de presença no termo v3). |
| F8 | Provar o aceite e a revogação (evidências) | Cumprimento de obrigação/exercício regular de direitos (art. 7º, II e VI) | Prazo de guarda das evidências a definir (J7). |

### 4.1 Registro autorizado pela escola — bases propostas **por grupo** (migration `20260929100000`)

> ⚠️ **Tudo nesta subseção é proposta técnica para revisão jurídica.**

**Decisão da direção (27/09/2026):** a escola deixa de pedir aceite individual por link: o registro das aulas passa a ser **autorizado pela escola** (modo `SCHOOL_DEFAULT`, por escola, com trilha de quem decidiu, quando, motivo e base), e cada pessoa pode **pedir para não ser registrada** a qualquer momento, sem prejuízo das aulas. A Wise Wolf entrou nesse modo por migration (27/09/2026); as outras escolas seguem no aceite individual (F1 acima) até decidirem. Os novos contratos de aluno e de professor passam a trazer a cláusula do registro (frente própria).

| Grupo | Base proposta | Condições / observações para o jurídico |
| --- | --- | --- |
| Aluno ou professor com **contrato novo, com a cláusula** do registro | Execução de contrato (art. 7º, V) | A cláusula precisa descrever o registro (transcrição, anotações, presença, IA com aprovação humana, quem vê, prazos) e o direito de pedir para não ser registrado sem prejuízo. Para o professor PJ/MEI, contrato de prestação de serviços. |
| Aluno ou professor **atual** (contrato sem a cláusula) | Legítimo interesse (art. 7º, IX), com aviso (art. 9º e art. 10, §2º) e **direito de oposição** (art. 18, §2º) | Fazer o teste de balanceamento (LIA) — J12. Transparência: o aviso v4 está no app (cartão do professor, "Minhas aulas registradas") e na página de um link do termo emitido antes da troca de modo (na Wise Wolf não há nenhum: 0 links em 27/09/2026), **mas não é enviado automaticamente a ninguém** — definir como dar ciência às famílias e aos professores atuais (J13). |
| **Menores de idade** (turma infantil, menor pela data atestada ou idade não comprovada) | Melhor interesse da criança e do adolescente (art. 14, *caput*), com a base do grupo acima (contrato novo ou legítimo interesse), conforme o **Enunciado CD/ANPD nº 1/2023** (as hipóteses dos arts. 7º e 11 podem ser usadas para dados de crianças e adolescentes, observado o melhor interesse) — a confirmar | A direção decidiu **incluir os menores** no registro autorizado pela escola (sem aceite do responsável). O pedido para não registrar pode vir do responsável. ⚠️ **Na Wise Wolf o único canal do aluno e da família é o WhatsApp da escola**, com a direção registrando o pedido (e o motivo) no painel: no modo da escola não se gera link nem se manda o termo, e a página pública só existe para quem recebeu um link antes da troca de modo (0 links na Wise Wolf em 27/09/2026). Não há canal próprio do responsável no app — ver J13/J14. Proteções que seguem: cartão de menor só com objetivo e temas; sugestões da IA só desses campos; transcrição bruta só para quem deu a aula, coordenação e direção. Avaliar se o melhor interesse sustenta a transcrição por padrão e a IA (J14). |
| IA (resumo, planejamento, sugestões do cartão) no modo da escola | A mesma base do grupo, com a IA descrita no aviso v4 | O aviso em vigor no fim da aula precisa declarar a IA (v4 declara); pedido para não registrar antes do fim da aula tira a IA daquela aula. Transferência internacional segue em J5. |

O que **não** mudou com o modo da escola: a conta Google do professor continua confirmada por login para ele virar coanfitrião (sem ela não há sala); retenção e exclusão a pedido; o relatório de presença só sinaliza; o texto não pede aceite ("Li e autorizo") — é **aviso** (`kind = 'NOTICE'`), e nunca vira o termo exigido de quem segue no aceite individual.

## 5. Descrição do fluxo

> **Dois modos por escola (migration `20260929100000`).** Passos 2–3 abaixo descrevem o **aceite individual**. No **registro autorizado pela escola** (Wise Wolf desde 27/09/2026) não há link, código nem aceite: aluno e professor ativos estão autorizados; o aluno ou o responsável pede para não ser registrado pelo WhatsApp da escola (a direção — ou a coordenação — registra o pedido com motivo; a página pública só vale para um link emitido antes da troca de modo, e na Wise Wolf não há nenhum), e o professor pelo app ou pelo WhatsApp — e o pedido vale na hora, como a revogação do passo 6. Só a direção desfaz um pedido, com motivo; o pedido que o professor fez no app só ele desfaz. A troca de modo é só da direção, com motivo e trilha, e vale pela hora do fim da aula (aula já dada não muda).

1. A escola conecta a conta central Google (OAuth com PKCE; token cifrado AES-GCM, fora do navegador).
2. O professor confirma a própria conta Google por login (`teacher_identity_connect`) e aceita o termo do professor no app.
3. O aluno adulto ou o responsável recebe o link do termo (lote pelo WhatsApp da escola, ou link gerado pela direção), lê o texto vigente e decide com **código de 6 dígitos** enviado ao telefone atestado pela escola.
4. A cada 15 minutos, o job marca as aulas das próximas 24 h em que **os dois aceites da versão vigente** existem; a sala do Meet nasce com transcrição e anotações ligadas e o professor como coanfitrião.
5. Depois da aula, a transcrição, as anotações e o relatório de presença são copiados para o sistema; o resumo é preparado (notas nativas ou IA) e **só entra na ficha depois da aprovação do professor**.
6. Recusa, revogação, aceite que cai (menor que respondeu como adulto) ou **termo que muda de versão** tiram o aceite efetivo na hora das aulas que ainda não terminaram: a sala tem a transcrição desligada no Google, some do app e do lembrete, e a importação é recusada. Aula que terminou antes segue os prazos do termo que valia nela (a versão exigida é a do fim previsto da aula).
7. Retenção diária apaga cópias vencidas, tira os trechos da aula de todo resumo (rascunho e aprovado) 90 dias depois dela e, para quem deixou a escola há mais de 90 dias, apaga memória `MEET_SESSION`, cartão e conteúdo dos resumos.

## 6. Transferência internacional

Google Workspace e o provedor de IA (OpenRouter e os modelos que ele aciona) podem processar dados fora do Brasil. **Pendência J5:** definir o mecanismo do art. 33 (ex.: cláusulas-padrão contratuais da ANPD — Resolução CD/ANPD nº 19/2024, a confirmar — ou consentimento específico e em destaque, art. 33, VIII) e registrar no termo, se necessário.

## 7. Riscos identificados

| # | Risco | Probabilidade / impacto (proposta) | Medidas existentes | Risco residual / ação |
| --- | --- | --- | --- | --- |
| R1 | **Menores**: coleta de voz/conteúdo de criança sem autorização válida do responsável; alguém se passar pelo responsável | média / alto | Idade desconhecida = responsável (fail-closed); data de nascimento só vale atestada pela escola; código de 6 dígitos no telefone **atestado** e congelado no link; tetos de envio e tentativas com bloqueio do link; aceite "como aluno" de quem vira menor cai na hora; cartão de menor só com objetivo e temas, campos pessoais **apagados** quando o aluno vira menor | Médio. Validar ponta a ponta com responsável de verdade antes de ligar para turmas infantis (runbook, piloto passo 3). |
| R2 | **Monitoramento de prestador (professor PJ/MEI)**: presença e pontualidade usadas como controle de jornada/avaliação; risco trabalhista (indício de subordinação) e efeito inibidor | média / alto | Presença só abre caso para conversa; nada altera pagamento, folha ou `class_logs`; a API do Meet não é usada para ler participantes (limite de uso do Google); extrato de pontualidade sem nota nem ranking e **desligado até o parecer** | Alto até o parecer. Decisão do jurídico antes de ligar F7. |
| R3 | **IA**: resumo errado ("alucinação"), vazamento ao provedor, uso para treino, instrução maliciosa escondida na fala (prompt injection) | média / médio | A transcrição só vai ao provedor com aceite de termo que declara a IA (v3 em diante), do aluno e do professor, valendo no fim da aula — aula dada sob a v2 ou marcada à mão sem resposta no sistema fica fora, também no botão manual (`private.meet_summary_ai_consented`); aprovação humana obrigatória antes da ficha; citações precisam ser trechos literais da fonte; o texto da aula vai ao modelo marcado como dado não confiável, sem ferramentas nem envio de mensagens; provedor pago com treino desligado; teto de gasto mensal (frente própria) | Médio. Confirmar contrato e configuração do provedor (J3). |
| R4 | **Dados sensíveis incidentais** na transcrição | média / alto | Transcrição bruta só para o professor da aula, coordenação e direção; cópia apagada em 90 dias; cartão proíbe temas sensíveis; suporte da plataforma não vê o bruto | Médio. |
| R5 | **Acesso interno indevido** (outro professor, suporte) | baixa / alto | `session_detail` com `raw_access` só para quem deu/coordena a aula; o suporte da plataforma (`SUPER_ADMIN`) vê só resumo aprovado e cartão, e o termo v3 diz isso; resumo aprovado e depois rejeitado deixa de ser servido como aprovado a quem não vê a fonte (a última decisão humana vale); os trechos da aula saem do resumo aprovado em 90 dias; leituras registradas em `google_meet_access_events`; schema `private` fora da Data API; teste `security_definer_authorization_hardening.sql` | Baixo. Avaliar se o suporte precisa mesmo ler resumo de escola cliente (J6). |
| R6 | **Escopo amplo do Drive** (`drive.readonly`) na conta central | baixa / alto | Token cifrado e só no servidor; o código abre só o documento indicado pela API do Meet e planilhas da própria conta com o código da sala; conta dedicada às aulas | Médio. Revisar se o Google passar a exportar com `drive.meet.readonly`. |
| R7 | **Originais no Google** além do prazo prometido | média / médio | Termo promete apagar 90 dias depois da aula (lixeira do Google, eliminação definitiva em até 30 dias). A lixeira automática existe (`20260927120000`: só arquivo com id da Meet API ou planilha identificada pelo código da sala, conferido `ownedByMe`), mas nasce **desligada** (`GOOGLE_MEET_DELETE_ORIGINALS_ENABLED`, escopo `drive` e reconexão da conta central) | **Alto até a flag ser ligada.** O primeiro original vence 90 dias depois da primeira aula transcrita sob a v3; até lá, ligar a flag e reconectar, ou remoção manual pela direção. Planilha do plano B, conta central anterior e aula fora da janela da Meet API ficam para conferência manual (a tela da direção conta). |
| R8 | **Consentimento desatualizado** (pessoa aceitou texto antigo, ou aceitou um texto que não leu) | média / médio | Aceite só vale na **versão vigente** (migration `20260927100000`); o job desmarca as aulas futuras marcadas pelo termo antigo; a marcação manual da direção não liga aula de quem tem aceite de versão anterior, e a marcada antes da versão nova perde o aceite efetivo; página e cartão dizem "o termo mudou"; a página e o cartão mandam a versão exibida e o servidor recusa (`termo_mudou`) o aceite de outra versão — publicar um texto com a tela aberta não vira aceite do texto novo | Baixo. |
| R9 | **Revogação que não pega** a aula em andamento | baixa / alto | Revogação antes do fim previsto barra na hora (`lesson_session_documentation_blocked`); a sala tem a transcrição desligada no Google (`spaces.patch`) | Baixo. |
| R10 | **Direitos do titular sem fluxo formal** (acesso, correção, exclusão) | média / médio | Termo indica WhatsApp da escola e contato de privacidade; o aluno vê os resumos aprovados no app ("Minhas aulas registradas", `20260927140000`); a exclusão a pedido é o botão da direção na ficha (`erase_student_lesson_records`, `20260927120000`), que apaga cópias, resumos, memória (inclusive a que o Planner propôs a partir das aulas aprovadas), cartão e a base das aulas nos planos, e manda os originais para a lixeira; a confirmação de leitura do dossiê guarda só referências, sem texto | Médio. Definir prazo de resposta e identificação do solicitante (J8). Os planos do Planner (material do professor gerado com IA a partir do resumo aprovado) ficam, sem a base copiada e sem voltar ao modelo como continuidade — decidir se entram na exclusão (J11). |
| R11 | **Terceiros na sala** | baixa / baixo | Relatório de presença só resume professor, aluno e organizador; transcrição apagada em 90 dias | Baixo. |
| R12 | **Incidente de segurança** | baixa / alto | VPS própria, segredos fora do Git, RLS, funções `SECURITY DEFINER` revisadas | Plano de comunicação à ANPD e aos titulares (Resolução CD/ANPD nº 15/2024, a confirmar) — J9. |
| R13 | **Registro autorizado pela escola (sem aceite individual)**: a pessoa não sabe que é registrada, não sabe como pedir para não ser, ou o menor é registrado sem o responsável ter sido avisado (`20260929100000`) | média / alto | Aviso v4 no app (cartão do professor, "Minhas aulas registradas" com o botão pronto do WhatsApp) e na página de link emitido antes da troca de modo (nenhum na Wise Wolf); pedido para não registrar vale na hora (sala desligada, nada importado, IA fora) — do aluno e da família **só pelo WhatsApp da escola**, registrado pela direção ou coordenação com motivo; do professor pelo app ou pelo WhatsApp —, e só a direção (com motivo) o desfaz, salvo o pedido que o professor fez no app, que só ele desfaz; trilha da decisão da escola (quem, quando, motivo, base) e de cada pedido; só a direção troca o modo, com confirmação na tela; contratos novos com a cláusula; aluno/professor inativo sai do padrão; cartão de menor segue restrito | **Alto até o jurídico** validar as bases por grupo (§4.1) e decidir como dar ciência aos atuais (J12–J14). Não há envio automático do aviso. |
| R14 | **Troca de modo mal usada** (direção liga o padrão sem base, ou volta ao individual e derruba aulas) | baixa / médio | Só `SCHOOL_ADMIN` ativo troca, com motivo gravado e confirmação na tela que lista o que muda; a aula segue o modo do fim dela (aula já dada não é autorizada nem barrada depois); nunca update/delete na trilha | Baixo. |

## 8. Medidas técnicas e organizacionais já implementadas

- **Modo de autorização por escola** (`20260929100000`): `private.lesson_recording_authorization_modes` (trilha: autor, dia da decisão, motivo, base, origem), só a direção troca, pela tela, com confirmação; a régua do aceite efetivo, da IA e do professor substituto segue o modo que valia no fim da aula; o pedido para não registrar (recusa/revogação) tira na hora; link e envio do termo recusados no servidor no modo da escola; aviso v4 como `NOTICE`, separado do termo de aceite. Teste `supabase/tests/registro_autorizado_pela_escola.sql`.
- **Termo versionado** (`private.lesson_recording_terms`): texto novo é versão nova, nunca update; o aceite guarda a versão lida (a tela manda a versão exibida e o servidor recusa outra com `termo_mudou`). v3 publicada em `20260927100000` com o controlador por marcadores, preenchidos no servidor (`private.lesson_recording_fill_term`) antes de o texto chegar a qualquer tela.
- **Aceite por versão**: `private.lesson_recording_student_consent_effective` e `private.lesson_recording_teacher_consent_effective` exigem a versão vigente; `private.lesson_recording_active` usa as duas. Para uma aula, vale a versão do fim previsto dela (`private.lesson_recording_active_at`).
- **Prova do aceite pelo link**: código de 6 dígitos por WhatsApp, só hash no banco, 10 min, 5 tentativas, tetos por link (`20260926200000`); evidências `verification`, `verified_phone` (mascarado), IP e navegador.
- **Idade e responsável**: data de nascimento atestada pela escola com trilha (`private.student_birth_date_records`, `profile_audit_log`); o aluno não altera nascimento, turma infantil, telefone nem vínculo do responsável.
- **Revogação efetiva na hora** e **sala desligada** (`20260926180000`); marcação manual só pela direção, com motivo, sem passar por cima de recusa nem de aceite de versão anterior do termo (`20260927100000`).
- **IA só com o termo que a declara**: resumo por IA (automático e manual) só para aula cujo aceite, no fim dela, é de versão que fala da IA (v3 em diante), do aluno e do professor.
- **Acesso ao bruto restrito** e leituras registradas (`google_meet_access_events`).
- **Aprovação humana** do resumo antes da memória do aluno; memória só com resumo aprovado.
- **Cartão do aluno** sem IA inventando: escrita só por `save_student_learning_card`, limites de tamanho, regra de menor, histórico sem texto (`20260926220000`).
- **Sugestões da IA para o cartão** (`20260928130000`): só de aula com resumo **aprovado**, com aceite do termo que declara a IA (v3) do aluno e do professor no fim da aula **e** hoje; OpenRouter com `data_collection = deny`; cada sugestão traz a frase literal da aula, conferida contra a fonte, e essa frase só chega a quem pode ler a transcrição daquela aula (o professor dela, a coordenação e a direção — outro professor do aluno vê só a contagem), com a leitura registrada em `google_meet_access_events`; lista de exclusão na edge e no banco; menor só objetivo e temas (também ao virar menor: as pendentes pessoais são apagadas); o professor aceita (grava pela RPC do cartão) ou descarta — o texto some ao decidir e a marca (hash) 90 dias depois; mesmo teto mensal do resumo; custo em `ai_usage_events`.
- **Retenção**: cópias brutas e presença com `expires_at` (90 dias, teto no banco — `lesson_memory_retention_policy().raw_copies_days` — e na edge; `purge_expired_meet_artifacts`); trechos da aula em todo resumo (rascunho e aprovado) 90 dias depois da aula, e memória `MEET_SESSION` (e a `PLANNER_AI` que o Planner propôs a partir das aulas aprovadas), cartão, resumos e a base das aulas aprovadas nos planos do Planner de quem saiu (`private.purge_lesson_memory_retention`, cron diário `wisewolf-lesson-memory-retention`), com trilha só de contagens; originais no Drive para a lixeira 90 dias depois da aula (`20260927120000`, com a flag ligada).
- **Exclusão a pedido** (`erase_student_lesson_records`, só a direção, com prévia): apaga numa transação cópias brutas, presença guardada, todas as versões de resumo, memória `MEET_SESSION` e a `PLANNER_AI` proposta a partir das aulas aprovadas, cartão e a base das aulas nos planos do Planner (com a memória proposta nela); os originais vencem na hora; as aulas não voltam a ser importadas nem resumidas; trilha sem texto (`private.student_lesson_record_erasures`).
- **Presença só sinaliza** (`meet_attendance_evaluate` → Central de Qualidade), sem efeito em pagamento.
- **Segurança de plataforma**: token OAuth cifrado AES-GCM com contexto da escola; PKCE; schema `private` fora da Data API; RLS; suíte de autorização das funções `SECURITY DEFINER`.

## 9. Pendências para o jurídico

- **J1** — Confirmar bases legais de F1 a F8 (em especial menores e presença).
- **J2** — Revisar o texto do termo v3 (aluno e professor) e o texto da mensagem de WhatsApp do envio em lote.
- **J3** — Contrato/DPA e configuração do provedor de IA (OpenRouter: treino desligado, retenção de prompts, provedores permitidos) e da Google (adendo de processamento de dados do Workspace).
- **J4** — Obrigatoriedade de encarregado: regime de agente de pequeno porte (Resolução CD/ANPD nº 2/2022, a confirmar) versus tratamento de alto risco (dados de crianças, tecnologia emergente); Resolução CD/ANPD nº 18/2024 sobre o encarregado (a confirmar).
- **J5** — Mecanismo de transferência internacional (§6).
- **J6** — Papéis contratuais escola (controladora) × plataforma (operadora).
- **J7** — Prazo de guarda das evidências de consentimento e dos registros de acesso.
- **J8** — Procedimento de atendimento aos direitos do titular (canal, prazo, identificação do solicitante).
- **J9** — Plano de resposta a incidentes.
- **J10** — Parecer sobre o extrato de pontualidade do professor (F7/R2) antes de ligar. Pontos: base legal; se a coordenação (além da direção) pode ver; o prazo de 90 dias (o termo v3 fala do relatório de presença, não do extrato); e se "saída antecipada" deve aparecer. Liberado, a plataforma liga por escola, com a referência do parecer registrada na trilha (runbook do Meet, seção do extrato).
- **J11** — Planos do Planner (lesson_plans, texto gerado com IA a partir do resumo aprovado): hoje ficam depois da exclusão e da saída do aluno, sem a base copiada do resumo, sem a memória proposta e sem voltar ao modelo como continuidade; o texto do plano (objetivo, atividades, lição) pode citar o próximo passo e os erros das aulas aprovadas. Decidir se entram na exclusão a pedido e na retenção.

- **J12** — Registro autorizado pela escola, **atuais sem a cláusula**: confirmar o legítimo interesse e fazer o teste de balanceamento (LIA); dizer se é preciso consentimento para alguma parte (IA, transferência internacional).
- **J13** — Como dar **ciência do aviso v4** aos alunos, famílias e professores atuais (hoje ele só está no app e na página de link emitido antes da troca de modo — nenhum na Wise Wolf; nada é enviado) e se o registro deve esperar essa comunicação. Avaliar também o **canal de oposição**: do aluno e da família é só o WhatsApp da escola (a direção registra o pedido); não há canal próprio no app para o responsável.
- **J14** — **Menores** no registro autorizado pela escola: validar a base (melhor interesse, Enunciado CD/ANPD nº 1/2023) para transcrição por padrão e para a IA; se o responsável precisa ser avisado antes da primeira aula registrada; e se o WhatsApp da escola, registrado pela direção, basta como canal para o responsável exercer a oposição (não há página nem código para ele no modo da escola).
- **J15** — Revisar o texto do **aviso v4** (aluno e professor) e alinhá-lo à cláusula dos contratos novos.

## 10. Aprovação

| Papel | Nome | Data | Assinatura |
| --- | --- | --- | --- |
| Encarregado (DPO) da escola | | | |
| Jurídico | | | |
| Direção | | | |

_Rascunho técnico gerado em 27/09/2026 a partir do código (migrations `20260926120000` a `20260929100000` — esta última, o registro autorizado pela escola, §4.1 e R13–R14 —, runbook `docs/runbooks/google-meet-pedagogical-documentation.md`). Atualizar a cada mudança de finalidade, fornecedor ou prazo._
