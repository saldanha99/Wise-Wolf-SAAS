# Auditoria de coerência dos universos do Wolfie Tutor

Data: 26/07/2026  
Escopo: catálogo, recomendação personalizada, geração de atividades, conversa, continuidade e fallback dos nove universos.

## WOLFIE-001 — atividade Kids desviava para cenário profissional

Prioridade: P1  
Status: corrigido e coberto por regressão automatizada.

### Evidência observada

Sessões recentes de produção continham atividades A1 como:

- `Present Simple: I like / I work – Hotel Expansion Mission`
- `Hotel Expansion Quest: Choose Your Path`

O desvio ocorria mesmo quando a experiência escolhida era infantil. Nos perfis afetados, profissão e meta profissional estavam vazias; portanto, “Hotel Expansion” vinha do motor/fallback, não de uma preferência confiável do aluno.

### Como reproduzia

1. Abrir o Wolfie Tutor.
2. Escolher uma experiência do universo Crianças e adolescentes, como `Game Worlds`.
3. Selecionar nível e iniciar uma atividade escrita.
4. Observar que título, cenário, exemplos ou perguntas podiam mudar para reuniões, empresas, clientes ou expansão de hotéis.

### Resultado esperado

Toda a atividade, conversa e continuação permanecem na experiência e no público escolhidos. Memória e perfil ajustam dificuldade e correção, mas não substituem o universo.

### Causa raiz

- o gerador se declarava orientado a adultos;
- as orientações B1–C2 e os conteúdos de reserva eram corporativos;
- o frontend enviava a experiência apenas como texto solto;
- profissão, metas e repertório antigo podiam prevalecer sobre a seleção atual;
- não existia uma verificação semântica posterior à geração.

### Correção aplicada

- contrato estruturado com ID, título, universo, modo, público e objetivo;
- validação frontend → backend para todas as experiências do catálogo;
- prioridade absoluta do universo selecionado;
- bloqueio de memória/repertório profissional em Kids/Teens;
- guarda semântica que rejeita vazamento corporativo;
- fallback contextual para cada universo e para todos os assuntos;
- metadados da experiência preservados na atividade, conversa e readaptação;
- recomendações e desafio diário filtrados por público.

## Matriz validada

| Universo | Catálogo | Contrato backend | Fallback contextual |
| --- | --- | --- | --- |
| Fale sobre sua vida | OK | OK | OK |
| Inglês do dia a dia | OK | OK | OK |
| Pratique falando | OK | OK | OK |
| Crianças e adolescentes | OK | OK | OK |
| Carreira | OK | OK | OK |
| Reuniões globais | OK | OK | OK |
| Eventos | OK | OK | OK |
| Provas internacionais | OK | OK | OK |
| Skill Labs | OK | OK | OK |

## Validações automatizadas

- 17 testes de regressão passaram.
- Mais 21 testes do Planner AI passaram após a seleção híbrida de modelos; total final: 38/38.
- Todos os IDs de experiências são únicos e resolvem para um universo.
- Todas as experiências reais do catálogo são aceitas pelo mesmo contrato usado no backend.
- Perfis Kids adversariais com metas corporativas não recebem recomendações profissionais.
- O caso exato `Game Worlds → Hotel Expansion` é recusado pela guarda semântica.
- Título correto com conteúdo de outro universo é recusado: o gate avalia os campos substantivos, não apenas o título.
- Descrição e objetivo enviados pelo cliente são substituídos pelo catálogo pedagógico canônico do servidor.
- A retomada de uma atividade Kids nunca escolhe um fallback adulto incompatível.
- Fallbacks Kids de vocabulário, gramática, listening e reading não contêm vazamento profissional.
- TypeScript e verificação Deno passaram.

## Validação de produção

Release final ativa: `20260726T173609Z-cd7f93168632`.

- Site público: HTTP 200.
- Preflight CORS de `wolfie-activity` e `wolfie-brain`: HTTP 200.
- Chamadas sem autenticação nas duas funções: HTTP 401, como esperado.
- Hashes de `wolfie-activity`, `personalization` e `wolfie-brain` idênticos entre a versão local validada e os arquivos ativos da VPS.
- Matriz funcional autenticada: 9/9 universos geraram uma atividade com ID e universo preservados. Ela foi executada na release `20260726T164916Z-e0ac3023e65e`; os hashes Wolfie permanecem idênticos na release final, que alterou somente a seleção avançada do Planner.
- Oito atividades vieram diretamente da IA; uma saída fora do escopo foi recusada pelo gate e trocada pelo fallback contextual seguro.
- O caso Kids com perfil profissional adversarial produziu uma missão infantil e não continha hotel, reunião corporativa, receita trimestral, cliente, prazo ou meta de vendas.
- Após trocar o fixture para perfil infantil, `Game Worlds` continuou válido e uma tentativa de abrir `Networking` profissional foi bloqueada com HTTP 403 (`AGE_INAPPROPRIATE_EXPERIENCE`).
- Limpeza pós-teste confirmada no banco e na autenticação: zero usuários, perfis e tenants temporários restantes.
- Login público carregou sem erro de console; evidência em `screenshots/production-login.png`.

## Seleção de modelos

- Planner AI econômico: `openai/gpt-4o-mini` para planos e tarefas estruturadas de A1–B1.
- Planner AI de maior precisão: `openai/gpt-5-mini` para B2–C2, feedback, teste oral, coaching, relatórios e retry de qualidade.
- Wolfie Tutor: `anthropic/claude-haiku-4.5` para conversação responsiva, com fallback de modelos e guardas pedagógicas determinísticas.
- O slug anterior de alta precisão foi removido do código, exemplos, documentação, testes e importador porque não correspondia a um modelo publicado no OpenRouter.
- Site final: HTTP 200; API Wolfie: HTTP 200 no preflight; Planner sem autenticação: HTTP 401.
- Hashes finais de Planner, personalização Wolfie e Wolfie Brain são idênticos entre workspace e VPS.
