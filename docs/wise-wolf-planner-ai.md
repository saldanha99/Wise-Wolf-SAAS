# Wolf Tutor, Planner AI e memória pedagógica

## Escopo

O Wolf Tutor atende o aluno durante a prática. O Planner AI atende professor e
coordenação na preparação de aulas, feedbacks, testes e materiais. Os dois podem
usar evidências da aprendizagem, mas não devem compartilhar prompts, permissões
ou históricos brutos.

A separação recomendada é:

| Conteúdo                                 | Destino                                                      | Regra                                               |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Perfil e evolução de um aluno            | banco relacional, por `tenant_id` e `student_id`             | nunca entra na base vetorial reutilizável           |
| Memória proposta pelo Planner AI         | `student_learning_memories`                                  | começa como `PROPOSED`                              |
| Memória importada do ChatGPT             | `student_learning_memories`                                  | sempre começa como `NEEDS_REVIEW`                   |
| Método, rubrica ou material reutilizável | `ai_knowledge_documents` + `ai_knowledge_chunks` no Supabase | somente após aprovação explícita                    |
| Conversa original exportada              | arquivo local temporário                                     | nunca é gravada no banco nem enviada para a geração |

A base vetorial é uma biblioteca pedagógica, não uma memória de aluno. Os
documentos aprovados são divididos em trechos sanitizados; o OpenRouter gera os
embeddings e o Supabase armazena e pesquisa esses vetores com `pgvector`. Essa
fronteira evita que o erro, profissão ou interesse de um aluno apareça no plano
de outro.

## Diagnóstico do Wolf Tutor

O caminho principal do aluno já usa `WolfiePracticeFlow` → `wolfie-brain` /
`wolfie-activity`, com OpenRouter e memória isolada por aluno. Esse deve continuar
como Tutor canônico. Ele não deve receber o prompt completo do Planner: os dois
produtos compartilham apenas fatos pedagógicos estruturados e verificados.

Ainda existe o endpoint legado `wolf-tutor-api`, usado por partes do Hub/chat e
dependente da OpenAI para texto, transcrição e voz. Ele não participa da nova RAG
do Planner e deve ser consolidado ou aposentado em uma migração separada, para
que não surja uma segunda memória concorrente do aluno.

## Fluxo do Planner AI

1. O professor seleciona o aluno e descreve a tarefa.
2. O servidor autoriza professor, aluno e tenant.
3. O servidor monta um contexto mínimo com perfil pedagógico e memórias recentes
   somente do aluno selecionado.
4. O OpenRouter gera o embedding da consulta, e uma função SQL recupera somente
   os trechos aprovados do tenant na tabela `ai_knowledge_chunks`.
5. O Planner envia esse contexto limitado ao Chat Completions do OpenRouter e
   exige uma resposta compatível com o JSON Schema.
6. A resposta estruturada é exibida como rascunho.
7. Ao salvar, o servidor persiste o plano e propõe um update de memória. Uma
   hipótese não deve substituir um fato verificado.

O histórico bruto de uma conversa não deve ser reenviado a cada geração. O banco
guarda resumos estruturados e a RAG guarda somente conhecimento reutilizável,
sanitizado e aprovado.

## Ativação do Planner AI

1. Aplique
   `supabase/migrations/20260726015015_wise_wolf_planner_ai_foundation.sql`.
2. Configure no runtime privado das Edge Functions:
   `OPENROUTER_API_KEY`,
   `OPENROUTER_PLANNER_MODEL=openai/gpt-4o-mini` para A1–B1 simples,
   `OPENROUTER_PLANNER_FALLBACK_MODEL=openai/gpt-5-mini` para B2–C2,
   avaliações e retry,
   `OPENROUTER_PLANNER_REASONING=low`,
   `OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small` e
   `OPENROUTER_PLANNER_HOURLY_LIMIT=40`.
3. Implante a função `lesson-planner` junto com `_shared/request-auth.ts`.
4. Registre uma base de conhecimento ativa para o tenant em
   `ai_knowledge_bases`. O conteúdo fica no próprio Supabase:
   `ai_knowledge_documents` preserva a proveniência e
   `ai_knowledge_chunks` guarda os trechos e embeddings.
5. Faça primeiro um teste sem base RAG. O Planner continuará funcionando com a
   memória estruturada e exibirá o estado `STRUCTURED_MEMORY_ONLY`.
6. Depois de indexar documentos aprovados, confirme que o retorno apresenta
   `mode=RAG` e as fontes recuperadas.

O padrão híbrido usa `openai/gpt-4o-mini` para planos, tarefas, roteiros,
vocabulário e materiais. Feedback, teste oral, coaching de apresentação e
relatório de progresso usam diretamente `openai/gpt-5-mini`. Antes da
normalização, o servidor valida a completude; se uma geração econômica vier sem
a quantidade mínima de blocos, minutos, exemplos, vocabulário ou perguntas, ela
é descartada e refeita uma única vez pelo modelo de maior precisão. A auditoria
em `planner_ai_runs.usage` registra `attempt_count`, `quality_retry`, custo e os
modelos solicitados e efetivamente usados.

Uma diferença de duração de até 10% pode ser corrigida deterministicamente pelo
normalizador, que sempre entrega o total solicitado. Nos modos que apenas geram
conteúdo futuro (`lesson_plan`, `homework`, `class_script`, `vocabulary` e
`material_generation`), o servidor remove atualizações factuais de memória: um
plano ainda não prova prática, erro, domínio ou ponto forte do aluno.

Exemplo de registro, substituindo o tenant pelo ID do ambiente:

```sql
insert into public.ai_knowledge_bases (
  tenant_id,
  provider,
  purpose,
  embedding_model,
  embedding_dimensions,
  version,
  status
)
values (
  '<tenant-id>',
  'OPENROUTER',
  'WISE_WOLF_PLANNER',
  'openai/text-embedding-3-small',
  1536,
  1,
  'ACTIVE'
);
```

O navegador nunca consulta vetores, escolhe a base nem informa o tenant da
busca. A Edge Function resolve esses dados a partir da sessão autorizada. A
função de busca filtra `tenant_id` e a base aprovada dentro da própria consulta
SQL, antes de ordenar por similaridade.

O prompt mestre fica versionado no código da função. Cada geração registra
versão do prompt, modelo, resposta, uso, latência e IDs dos trechos recuperados
para auditoria. O conteúdo recuperado é tratado como dado não confiável e não
pode substituir as instruções do sistema.

As chamadas de geração e embeddings exigem `data_collection: "deny"` e
`zdr: true` no roteamento do OpenRouter. Se nenhum endpoint compatível estiver
disponível, a operação falha de forma fechada; o sistema não relaxa essas regras
de privacidade silenciosamente.

### Segredos e rotação da chave

Uma chave enviada por chat deve ser considerada exposta. Revogue-a no painel do
OpenRouter, crie uma nova com limite de crédito adequado e cadastre a nova chave
somente em **Supabase Dashboard → Edge Functions → Secrets** ou com
`supabase secrets set NOME=VALOR` em um terminal privado. Evite colocar o valor
na linha de comando quando o histórico do shell estiver ativo. Nunca escreva a
chave em `.env.example`, Git, logs, relatórios ou mensagens. O deploy não cria o
segredo. Nenhuma variável secreta deve receber prefixo `VITE_`, porque esse
prefixo envia o valor ao navegador.

`SUPABASE_SERVICE_ROLE_KEY` e `OPENROUTER_API_KEY` ficam exclusivamente no
servidor/importador. As tabelas da RAG mantêm RLS habilitada e não concedem ao
navegador acesso direto aos vetores; a `service_role` só é usada em rotinas
privadas e auditáveis.

## Importação do histórico exportado do ChatGPT

O importador local é
[`scripts/import-wise-wolf-chatgpt.mjs`](../scripts/import-wise-wolf-chatgpt.mjs).
Ele aceita a estrutura `conversations.json` da exportação do ChatGPT.

### Garantias do importador

- nenhuma conversa não mapeada é processada;
- cada item importável exige `scope: "WISE_WOLF"`, `approved_for_import: true` e
  `pii_reviewed: true`;
- `redact_terms` deve existir em todo item importável, mesmo quando a revisão
  concluiu que a lista pode ficar vazia;
- um run aceita apenas um tenant;
- a seleção pode usar `conversation_id` ou um `exact_title` que corresponda a
  uma única conversa;
- nomes e outros termos conhecidos devem ser declarados em `redact_terms`;
- e-mails, telefones, CPF, CNPJ, números sensíveis, endereços e padrões de
  segredo são redigidos localmente antes da chamada ao OpenRouter;
- mensagens do histórico são tratadas como dados não confiáveis, não como
  instruções;
- a análise usa Chat Completions com Structured Outputs, JSON Schema estrito e
  roteamento que exige suporte aos parâmetros solicitados;
- memórias individuais só podem seguir o caminho `student_memory`;
- o caminho `student_memory` não aceita `knowledge_base_id`;
- o caminho `knowledge` não aceita `student_id`, exige
  `approved_for_reuse: true` e remove dados específicos de aluno;
- a base não é escolhida pelo arquivo de mapping nem pelo navegador: ela é
  resolvida em `ai_knowledge_bases` usando o tenant autorizado;
- cada trecho recebe embedding pelo OpenRouter e é salvo em
  `ai_knowledge_chunks` com o mesmo tenant e documento de origem;
- todo registro usa hashes de origem, checksum, run, modelo e resposta para
  proveniência e reexecução idempotente;
- um relatório só é salvo com `--report` e recebe permissão local `0600`.

Essas garantias reduzem risco, mas não substituem revisão humana. A pessoa que
prepara o mapping deve ler a conversa, preencher todos os nomes/empresas em
`redact_terms` e confirmar que a conversa pertence à Wise Wolf.

### 1. Obter a exportação

No ChatGPT, solicite a exportação em **Configurações → Controles de dados →
Exportar dados**. Extraia o arquivo recebido fora do repositório. Não copie o
ZIP, `conversations.json`, relatórios ou arquivos intermediários para Git.

### 2. Criar o mapping

Copie
[`docs/examples/wise-wolf-chatgpt-import-map.example.json`](examples/wise-wolf-chatgpt-import-map.example.json)
para um diretório privado fora do repositório e substitua os placeholders.

Destinos:

- `student_memory`: conversa vinculada a exatamente um aluno;
- `knowledge`: conteúdo metodológico reutilizável e aprovado;
- `exclude`: conversa identificada e descartada de forma explícita.

Use `conversation_id` sempre que possível. `exact_title` existe para facilitar a
migração por projeto, mas falha se houver dois títulos iguais.

Não mapeie a mesma conversa para dois alunos. Se uma conversa misturar alunos,
divida e revise o material fora deste pipeline; não tente adivinhar a autoria.

### 3. Validar sem rede

```bash
npm run import:wise-wolf-chatgpt -- \
  --export /diretorio-privado/conversations.json \
  --map /diretorio-privado/wise-wolf-map.json \
  --validate-only
```

Esse modo valida JSON, seletores, isolamento de tenant, destinos, mensagens e
fragmentação. Ele não chama OpenRouter ou Supabase e não cria arquivos, salvo
quando `--report` é informado.

### 4. Gerar uma prévia sanitizada

Configure `OPENROUTER_API_KEY` no ambiente privado do importador e, se quiser
substituir os padrões, `OPENROUTER_IMPORT_MODEL` e
`OPENROUTER_EMBEDDING_MODEL`. Não use variável com prefixo `VITE_`.

```bash
npm run import:wise-wolf-chatgpt -- \
  --export /diretorio-privado/conversations.json \
  --map /diretorio-privado/wise-wolf-map.json \
  --report /diretorio-privado/wise-wolf-preview.json
```

Sem `--apply`, esse é um dry-run: o texto redigido é analisado pelo OpenRouter,
mas nada é gravado no Supabase. O relatório contém candidatos sanitizados; ele
continua sendo um arquivo privado e deve ser apagado após a revisão.

Revise:

- se cada memória pertence ao aluno correto;
- se fatos incertos aparecem em `notes_to_verify`;
- se assuntos externos foram excluídos;
- se o Markdown de knowledge não contém nomes ou fatos individuais;
- se nível, faixa etária e tipo de material estão corretos;
- se o conteúdo é de fato reutilizável.

### 5. Aplicar

Além de `OPENROUTER_API_KEY`, carregue `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY` em ambiente seguro. A chave `service_role` é
privilegiada e nunca pode ir para navegador, mapping, relatório, shell history
ou Git.

```bash
npm run import:wise-wolf-chatgpt -- \
  --export /diretorio-privado/conversations.json \
  --map /diretorio-privado/wise-wolf-map.json \
  --report /diretorio-privado/wise-wolf-apply-report.json \
  --apply
```

Antes de gravar uma memória, o importador confirma que o perfil tem role
`STUDENT` e pertence ao tenant mapeado. A gravação usa:

- `source_type = CHATGPT_IMPORT`;
- `verification_status = NEEDS_REVIEW`;
- `source_ref` pseudonimizado;
- `metadata` com checksums e proveniência;
- nenhuma alteração de memória anterior.

Antes de indexar knowledge, o importador confirma que a base pertence ao tenant,
está `ACTIVE` e tem purpose `WISE_WOLF_PLANNER`. Ele cria primeiro o registro de
proveniência, divide o Markdown sanitizado em trechos, solicita os embeddings ao
OpenRouter e grava cada trecho em `ai_knowledge_chunks`. O documento acompanha
o status como `INDEXING`, `READY` ou `FAILED`.

O processo é reexecutável: itens com a mesma origem e checksum são ignorados. Se
uma execução terminar parcialmente, corrija a causa e execute novamente com os
mesmos arquivos.

## Revisão após a importação

Memórias importadas não devem influenciar o perfil consolidado até serem
revisadas. A coordenação deve:

1. filtrar `student_learning_memories` por tenant, aluno,
   `source_type = CHATGPT_IMPORT` e `verification_status = NEEDS_REVIEW`;
2. comparar a proposta com o histórico pedagógico autorizado;
3. marcar como `VERIFIED` apenas fatos corretos, ou `REJECTED` quando
   incorretos;
4. corrigir o perfil canônico por uma ação separada e auditável;
5. conferir `ai_knowledge_documents` e `ai_knowledge_chunks`, tratando entradas
   `FAILED` ou que permaneceram em `INDEXING`.

Não faça `UPDATE` em massa para transformar toda a fila em `VERIFIED`.

## Exclusão e recuperação

O arquivo exportado e os relatórios ficam fora do banco. Apague-os de forma
segura depois da conferência e também remova cópias de backup temporárias.

Para desfazer uma importação, use `metadata.import_run_id` para localizar as
memórias, documentos e trechos. Revise os alvos antes de excluir. Em knowledge,
remova somente os `ai_knowledge_chunks` vinculados ao documento e marque o
documento como `REMOVED`; não remova uma base inteira para desfazer um único
run.

## Variáveis

| Variável                          | Uso                                                                  |
| --------------------------------- | -------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`              | Chat Completions e Embeddings; somente servidor/importador           |
| `OPENROUTER_PLANNER_MODEL`        | modelo econômico A1–B1; padrão `openai/gpt-4o-mini`                 |
| `OPENROUTER_PLANNER_FALLBACK_MODEL` | B2–C2, avaliações e fallback; padrão `openai/gpt-5-mini`           |
| `OPENROUTER_PLANNER_REASONING`    | raciocínio dos modelos compatíveis; omitido no GPT-4o mini           |
| `OPENROUTER_IMPORT_MODEL`         | modelo do importador; padrão `openai/gpt-5-mini`                      |
| `OPENROUTER_EMBEDDING_MODEL`      | embeddings da RAG; padrão `openai/text-embedding-3-small`            |
| `OPENROUTER_PLANNER_HOURLY_LIMIT` | gerações por professor/hora; padrão `40`                             |
| `OPENROUTER_RAG_MATCH_COUNT`      | máximo de trechos recuperados; padrão `8`, limite `12`               |
| `OPENROUTER_RAG_MIN_SIMILARITY`   | corte de similaridade; padrão `0.50`, faixa `0.20–0.95`              |
| `SUPABASE_URL`                    | Data API do ambiente de destino; necessária só com `--apply`         |
| `SUPABASE_SERVICE_ROLE_KEY`       | escrita privilegiada; necessária só com `--apply`                    |
| `WISE_WOLF_IMPORT_CHUNK_CHARS`    | tamanho de trecho entre 12.000 e 100.000 caracteres; padrão `45.000` |
| `WISE_WOLF_EMBEDDING_CHUNK_CHARS` | tamanho do chunk vetorial; padrão `3.500`, faixa `1.000–8.000`        |
| `WISE_WOLF_EMBEDDING_BATCH_SIZE`  | embeddings por lote; padrão `24`, limite `32`                         |

## Referências oficiais

- [Exportar dados do ChatGPT](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)
- [Structured Outputs do OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs)
- [RAG com embeddings no OpenRouter](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/rag)
- [API de Embeddings do OpenRouter](https://openrouter.ai/docs/api_reference/embeddings)
- [Zero Data Retention do OpenRouter](https://openrouter.ai/docs/guides/features/zdr)
- [Roteamento e política de dados do OpenRouter](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Rotação de chaves do OpenRouter](https://openrouter.ai/docs/cookbook/administration/api-key-rotation)
- [Busca semântica e pgvector no Supabase](https://supabase.com/docs/guides/ai/semantic-search)
- [Segurança da Data API do Supabase](https://supabase.com/docs/guides/api/securing-your-api)
