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
| **Operador — plataforma** | Fornecedor da plataforma Wise Wolf (software e hospedagem em servidor próprio — VPS). | Contrato entre plataforma e escola deve prever papel de operador (pendência J6). Confirmar o país do servidor para o §6. |
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
| Derivados pedagógicos | resumo (objetivo, conteúdos, dificuldades, tarefa, próximo passo), memória do aluno | `private.lesson_summary_versions`, `public.student_learning_memories` (`MEET_SESSION`) | rascunho não aprovado: perde o texto bruto 90 dias após a aula; aprovado: enquanto estudar + 90 dias depois de sair |
| Preferências pedagógicas | cartão do aluno: objetivo, temas, estilo de correção, "o que evitar", observações | `public.student_learning_cards` | enquanto estudar + 90 dias depois de sair |
| Evidências de consentimento | nome digitado, relação (aluno/responsável), data/hora, IP, navegador, telefone mascarado que recebeu o código, versão do termo | `private.lesson_recording_consents` | não expira (prova do aceite e da revogação) — pendência J7 |
| Registros de acesso | quem leu a documentação de qual aula | `private.google_meet_access_events` | sem prazo definido — pendência J7 |
| Trilha de retenção | só contagens por escola e rodada | `private.lesson_memory_retention_runs` | sem prazo (não há dado pessoal) |

**Dados sensíveis (art. 5º, II, e art. 11):** o sistema **não coleta** de propósito, mas a transcrição pode captar, por acaso, fala sobre saúde, religião, política, família ou dinheiro. O cartão do aluno proíbe esses temas (texto do termo, aviso na tela, limites de tamanho) e, para menor, guarda só interesses pedagógicos.

## 4. Finalidades e bases legais **propostas** (para revisão do jurídico)

| # | Finalidade | Base proposta | Observação para o jurídico |
| --- | --- | --- | --- |
| F1 | Registrar a aula (transcrição e anotações) para continuidade pedagógica | Consentimento (art. 7º, I); menor: consentimento específico e em destaque de um dos pais/responsável (art. 14, §1º) | O desenho atual já é por consentimento revogável. Avaliar se a execução do contrato educacional (art. 7º, V) ou o legítimo interesse (art. 7º, IX) seriam mais adequados para parte do tratamento, e o Enunciado CD/ANPD nº 1/2023 sobre bases para dados de crianças e adolescentes (a confirmar). |
| F2 | Resumo automático por IA, revisado e aprovado pelo professor | Consentimento (F1), com a IA descrita no termo v3 | Transferência internacional (§6). Não há decisão automatizada com efeito sobre o titular (art. 20): o resumo só entra na ficha depois da aprovação humana. |
| F3 | Planejar próxima aula e tarefa com IA a partir do resumo aprovado | Consentimento (F1) / execução do contrato educacional | Usa só o resumo aprovado e o cartão. |
| F4 | Dossiê para o novo professor ou substituto (link com login) | Execução do contrato educacional (art. 7º, V) ou legítimo interesse | Acesso limitado a quem vai dar a aula; transcrição bruta fica fora. |
| F5 | Cartão do aluno (sugestões da IA revisadas pelo professor) | Consentimento (F1) / legítimo interesse | Nunca dados sensíveis; menor só interesses pedagógicos. |
| F6 | Confirmar que a aula aconteceu (relatório de presença) | Legítimo interesse (art. 7º, IX) com teste de balanceamento, ou execução do contrato com o professor | **Só sinaliza** caso na Central de Qualidade; não altera pagamento (decisão da direção). |
| F7 | Extrato de pontualidade do professor (sem nota, sem ranking, visível a ele) | Legítimo interesse, **só depois do parecer** | Desligado até o jurídico decidir (risco R2). |
| F8 | Provar o aceite e a revogação (evidências) | Cumprimento de obrigação/exercício regular de direitos (art. 7º, II e VI) | Prazo de guarda das evidências a definir (J7). |

## 5. Descrição do fluxo

1. A escola conecta a conta central Google (OAuth com PKCE; token cifrado AES-GCM, fora do navegador).
2. O professor confirma a própria conta Google por login (`teacher_identity_connect`) e aceita o termo do professor no app.
3. O aluno adulto ou o responsável recebe o link do termo (lote pelo WhatsApp da escola, ou link gerado pela direção), lê o texto vigente e decide com **código de 6 dígitos** enviado ao telefone atestado pela escola.
4. A cada 15 minutos, o job marca as aulas das próximas 24 h em que **os dois aceites da versão vigente** existem; a sala do Meet nasce com transcrição e anotações ligadas e o professor como coanfitrião.
5. Depois da aula, a transcrição, as anotações e o relatório de presença são copiados para o sistema; o resumo é preparado (notas nativas ou IA) e **só entra na ficha depois da aprovação do professor**.
6. Recusa, revogação, aceite que cai (menor que respondeu como adulto) ou **termo que muda de versão** tiram o aceite efetivo na hora: a sala tem a transcrição desligada no Google, some do app e do lembrete, e a importação é recusada.
7. Retenção diária apaga cópias vencidas e, para quem deixou a escola há mais de 90 dias, memória `MEET_SESSION`, cartão e conteúdo dos resumos.

## 6. Transferência internacional

Google Workspace e o provedor de IA (OpenRouter e os modelos que ele aciona) podem processar dados fora do Brasil. **Pendência J5:** definir o mecanismo do art. 33 (ex.: cláusulas-padrão contratuais da ANPD — Resolução CD/ANPD nº 19/2024, a confirmar — ou consentimento específico e em destaque, art. 33, VIII) e registrar no termo, se necessário.

## 7. Riscos identificados

| # | Risco | Probabilidade / impacto (proposta) | Medidas existentes | Risco residual / ação |
| --- | --- | --- | --- | --- |
| R1 | **Menores**: coleta de voz/conteúdo de criança sem autorização válida do responsável; alguém se passar pelo responsável | média / alto | Idade desconhecida = responsável (fail-closed); data de nascimento só vale atestada pela escola; código de 6 dígitos no telefone **atestado** e congelado no link; tetos de envio e tentativas com bloqueio do link; aceite "como aluno" de quem vira menor cai na hora; cartão de menor só com objetivo e temas, campos pessoais **apagados** quando o aluno vira menor | Médio. Validar ponta a ponta com responsável de verdade antes de ligar para turmas infantis (runbook, piloto passo 3). |
| R2 | **Monitoramento de prestador (professor PJ/MEI)**: presença e pontualidade usadas como controle de jornada/avaliação; risco trabalhista (indício de subordinação) e efeito inibidor | média / alto | Presença só abre caso para conversa; nada altera pagamento, folha ou `class_logs`; a API do Meet não é usada para ler participantes (limite de uso do Google); extrato de pontualidade sem nota nem ranking e **desligado até o parecer** | Alto até o parecer. Decisão do jurídico antes de ligar F7. |
| R3 | **IA**: resumo errado ("alucinação"), vazamento ao provedor, uso para treino, instrução maliciosa escondida na fala (prompt injection) | média / médio | Aprovação humana obrigatória antes da ficha; citações precisam ser trechos literais da fonte; o texto da aula vai ao modelo marcado como dado não confiável, sem ferramentas nem envio de mensagens; provedor pago com treino desligado; teto de gasto mensal (frente própria) | Médio. Confirmar contrato e configuração do provedor (J3). |
| R4 | **Dados sensíveis incidentais** na transcrição | média / alto | Transcrição bruta só para o professor da aula, coordenação e direção; cópia apagada em 90 dias; cartão proíbe temas sensíveis; suporte da plataforma não vê o bruto | Médio. |
| R5 | **Acesso interno indevido** (outro professor, suporte) | baixa / alto | `session_detail` com `raw_access` só para quem deu/coordena a aula; leituras registradas em `google_meet_access_events`; schema `private` fora da Data API; teste `security_definer_authorization_hardening.sql` | Baixo. |
| R6 | **Escopo amplo do Drive** (`drive.readonly`) na conta central | baixa / alto | Token cifrado e só no servidor; o código abre só o documento indicado pela API do Meet e planilhas da própria conta com o código da sala; conta dedicada às aulas | Médio. Revisar se o Google passar a exportar com `drive.meet.readonly`. |
| R7 | **Originais no Google** além do prazo prometido | média / médio | Termo promete apagar 90 dias depois da aula (lixeira do Google, eliminação definitiva em até 30 dias) | **Depende da frente que implementa a remoção no Drive** (exige escopo de escrita). Até lá, remoção manual pela direção. |
| R8 | **Consentimento desatualizado** (pessoa aceitou texto antigo) | média / médio | Aceite só vale na **versão vigente** (migration `20260927100000`); o job desmarca as aulas marcadas pelo termo antigo; página e cartão dizem "o termo mudou" | Baixo. |
| R9 | **Revogação que não pega** a aula em andamento | baixa / alto | Revogação antes do fim previsto barra na hora (`lesson_session_documentation_blocked`); a sala tem a transcrição desligada no Google (`spaces.patch`) | Baixo. |
| R10 | **Direitos do titular sem fluxo formal** (acesso, correção, exclusão) | média / médio | Termo indica WhatsApp da escola e contato de privacidade; aluno vê os resumos aprovados no app (frente própria) | Médio. Definir procedimento e prazo de resposta (J8). |
| R11 | **Terceiros na sala** | baixa / baixo | Relatório de presença só resume professor, aluno e organizador; transcrição apagada em 90 dias | Baixo. |
| R12 | **Incidente de segurança** | baixa / alto | VPS própria, segredos fora do Git, RLS, funções `SECURITY DEFINER` revisadas | Plano de comunicação à ANPD e aos titulares (Resolução CD/ANPD nº 15/2024, a confirmar) — J9. |

## 8. Medidas técnicas e organizacionais já implementadas

- **Termo versionado** (`private.lesson_recording_terms`): texto novo é versão nova, nunca update; o aceite guarda a versão lida. v3 publicada em `20260927100000` com o controlador por marcadores.
- **Aceite por versão**: `private.lesson_recording_student_consent_effective` e `private.lesson_recording_teacher_consent_effective` exigem a versão vigente; `private.lesson_recording_active` usa as duas.
- **Prova do aceite pelo link**: código de 6 dígitos por WhatsApp, só hash no banco, 10 min, 5 tentativas, tetos por link (`20260926200000`); evidências `verification`, `verified_phone` (mascarado), IP e navegador.
- **Idade e responsável**: data de nascimento atestada pela escola com trilha (`private.student_birth_date_records`, `profile_audit_log`); o aluno não altera nascimento, turma infantil, telefone nem vínculo do responsável.
- **Revogação efetiva na hora** e **sala desligada** (`20260926180000`); marcação manual só pela direção, com motivo, sem passar por cima de recusa.
- **Acesso ao bruto restrito** e leituras registradas (`google_meet_access_events`).
- **Aprovação humana** do resumo antes da memória do aluno; memória só com resumo aprovado.
- **Cartão do aluno** sem IA inventando: escrita só por `save_student_learning_card`, limites de tamanho, regra de menor, histórico sem texto (`20260926220000`).
- **Retenção**: cópias brutas e presença com `expires_at` (90 dias, `purge_expired_meet_artifacts`); rascunhos, memória `MEET_SESSION`, cartão e resumos de quem saiu (`private.purge_lesson_memory_retention`, cron diário `wisewolf-lesson-memory-retention`), com trilha só de contagens.
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
- **J10** — Parecer sobre o extrato de pontualidade do professor (F7/R2) antes de ligar.

## 10. Aprovação

| Papel | Nome | Data | Assinatura |
| --- | --- | --- | --- |
| Encarregado (DPO) da escola | | | |
| Jurídico | | | |
| Direção | | | |

_Rascunho técnico gerado em 27/09/2026 a partir do código (migrations `20260926120000` a `20260927100000`, runbook `docs/runbooks/google-meet-pedagogical-documentation.md`). Atualizar a cada mudança de finalidade, fornecedor ou prazo._
