# Auditoria estrutural e de inteligência dos agentes de IA

Data: 26/07/2026

## Resultado executivo

O caso “aluno já fechou contrato e recebe nova oferta de contrato/matrícula” não era uma alucinação isolada do modelo. Era uma falha de arquitetura de estado: CRM, oportunidade, link de matrícula e perfil/contrato podiam discordar, enquanto cada automação lia apenas uma parte desse conjunto.

Três causas críticas foram confirmadas:

1. `crm_leads.status` podia continuar em `NEW`, `CONTACTED` ou `TRIAL_DONE` depois de `profiles.contract_accepted=true`.
2. O pós-experimental procurava somente `enrollment_links.status='PENDING'`. Depois que o link era usado, a consulta não encontrava a proposta e concluía, incorretamente, que nenhuma proposta existia.
3. As funções comerciais e internas de IA não faziam parte da release transacional da VPS. Uma correção local podia nunca chegar ao runtime que envia WhatsApp.

A solução implementada torna contrato/perfil, contrato ativo, oportunidade ganha e matrícula em processamento/concluída fontes de supressão comercial. A decisão é determinística e ocorre antes de qualquer chamada de IA ou envio.

Na verificação agregada do ambiente ativo foram encontrados **4 leads contratados ainda fora do estado terminal** e **6 oportunidades com link usado que a regra antiga interpretava como ausência de proposta pendente**. A migration reconciliou os 4 leads; a política publicada bloqueia os 6 casos de link usado. Após a ativação, a contagem de leads contratados divergentes caiu para zero.

## Inventário e avaliação

| Grupo | Agente/runtime | Papel real | Avaliação após auditoria |
|---|---|---|---|
| Externo | Bia / SDR (`whatsapp-inbound`) | Qualifica lead e solicita experimental | Mantido, agora bloqueado por estado contratual antes do prompt |
| Externo | SDR determinístico (`funnel-sweeper`, `sdr-followups`) | Primeiro toque e follow-ups | Corrigido com supressão central e modo fail-closed |
| Externo | Pós-experimental (`post-trial-pipeline`) | Lembra proposta/matrícula | Falha P0 corrigida; link `USED` não significa mais “sem proposta” |
| Externo | Michelle / RH (`hr-ai-screening`, inbound RH) | Triagem e pré-entrevista | Nome, papel e conversa inicial alinhados; currículo tratado como dado não confiável |
| Externo | Atendimento de aluno no WhatsApp | Encaminha aluno já contratado | Criado roteamento seguro: não vende, acusa recebimento e transfere ao humano |
| Externo | Wolfie Brain | Tutor conversacional canônico | Boa separação de papel, autenticação, tenant, cobrança e memória evidenciada |
| Externo | Wolfie Activity | Atividades, quiz, escrita e reuniões | Estrutura forte: schemas, normalização, fallback e isolamento de dados não confiáveis |
| Externo | Wolfie Live | Tutor de voz | Memórias e campos de perfil passaram a ser delimitados/escapados contra injeção de prompt |
| Interno | Planner AI | Planejamento do professor | Estrutura forte: autorização por aluno/tenant, RAG e salvamento transacional |
| Interno | Insights pedagógicos | Orientação baseada em aulas | Estrutura forte: autorização por papel, cache e proteção contra instruções em registros |
| Interno | Avaliador Wolfie | Avalia sessões | Adicionadas proteção contra injeção, validação HTTP e validação de notas/saída |
| Interno | Equipe de IA da escola | Secretária, comercial, pedagógico, financeiro e RH | Backend agora executa os cinco papéis anunciados pelo painel; comercial exclui contratados |
| Interno | Digest da direção | Resumo executivo | Notas e nomes agora são explicitamente tratados como dados não confiáveis |
| Legado | `ai-servers/1..5` | Protótipos locais separados | Sem consumidor de produção encontrado; substituídos pelo Wolfie canônico e não incluídos na release |

## Mudanças de arquitetura

### 1. Política comercial única

`commercial-contact-policy.ts` centraliza:

- normalização e comparação de telefone brasileiro, tolerando DDI e nono dígito sem cruzar DDD;
- estados terminais do lead (`WON`, `CONVERTED` e aliases legados);
- contrato aceito no perfil;
- contrato de aluno ativo/pausado;
- oportunidade com `conversion_status='WON'` ou `student_id` atribuído;
- link de matrícula `PROCESSING` ou `USED`;
- reconciliação automática do cartão do CRM para `WON` e `ai_handoff=true`.

Se a leitura dessa fonte de verdade falhar, as automações comerciais não enviam. É preferível perder temporariamente um follow-up a vender novamente para um aluno.

### 2. Reconciliação no banco

A migration `20260726121622_reconcile_contracted_students_with_commercial_ai.sql`:

- cria o gatilho que move leads relacionados para `WON` quando o contrato é aceito;
- repara divergências históricas por `student_id`, e-mail ou telefone normalizado;
- normaliza o alias antigo `CONVERTED` para `WON`;
- registra no histórico as colunas/tabelas operacionais que antes existiam apenas no ambiente;
- cria o RPC seguro `set_ai_team_config`, que o painel já chamava mas não estava versionado;
- mantém as tabelas internas de mensagens/deduplicação sem acesso de navegador.

### 3. Última barreira antes do envio

As seguintes rotas agora revalidam o contato antes de enviar:

- primeiro contato do SDR;
- follow-up do SDR;
- notificação de novo lead;
- nudge pós-experimental;
- lembretes D1/D3/D7 do link;
- atendimento inbound que chegaria ao prompt comercial;
- relatório interno que lista “quem ainda falta matricular”.

### 4. Release e rollback

A release da VPS passou a incluir as funções comerciais, RH, equipe interna, digest, avaliador e Wolfie Live, além da política compartilhada e da migration. Foram adicionadas:

- checagem Deno antes da publicação;
- backup/rollback dos novos artefatos;
- verificação do gatilho e das funções SQL;
- smoke tests de autenticação/token para cada nova rota publicada.

## Falhas de inteligência corrigidas

- O prompt deixou de ser usado como mecanismo primário de segurança comercial; a IA nem é chamada quando o estado é terminal.
- O RH tinha duas personalidades e dois roteiros: “Rita” enviava cinco perguntas de uma vez e “Michelle” esperava dez etapas conversacionais. A abertura agora é única, feita por Michelle, e pede consentimento para começar uma pergunta por vez.
- O painel declarava cinco funcionários virtuais, mas o backend só produzia quatro relatórios. O relatório de RH foi implementado.
- Currículos, notas internas, memória do aluno, transcript e configuração de sessão receberam instruções explícitas de isolamento contra prompt injection.
- A saída do avaliador pedagógico agora é rejeitada se as notas não estiverem entre 1 e 5 ou se faltar feedback válido.

## Testes executados

- 6 testes unitários da política comercial: todos aprovados.
- Deno `check` em todas as funções alteradas: aprovado.
- TypeScript do frontend: aprovado.
- Build de produção do Vite com configuração pública sintética: aprovado.
- Validação sintática do script de release: aprovada.
- `git diff --check`: aprovado.
- Smoke tests das 10 funções publicadas: respostas de proteção esperadas (`401`, `403` ou `426`) e todos os módulos carregados pelo Edge Runtime.
- Verificação pós-migration em produção: um gatilho ativo, RPCs presentes e zero leads contratados em estado comercial aberto.

O banco local não pôde executar a migration porque o Docker não estava ativo. A migration foi aplicada no banco ativo dentro de transação, depois de um `pg_dump` validado. As funções anteriores e o banco ficaram preservados em `/opt/wisewolf/backups/agent-audit-20260726T123435Z` para rollback.

## Riscos residuais e decisão

- Os cinco servidores em `ai-servers/` são protótipos sem integração encontrada. Devem permanecer fora de produção; uma remoção física pode ser feita em limpeza separada para não apagar material histórico nesta correção.
- Existem duas telas antigas de CRM. O estado vencedor foi unificado em `WON`; o Kanban de marketing foi alinhado ao CRM principal.
- Não foi executado teste ponta a ponta com WhatsApp real, pois isso enviaria mensagem externa. As novas verificações são determinísticas e cobertas por testes unitários sem contato real.
