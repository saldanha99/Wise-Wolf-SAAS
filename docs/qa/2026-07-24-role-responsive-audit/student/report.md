# Auditoria exploratória — Aluno

Data: 2026-07-24
Ambiente: produção
Perfil: `STUDENT`
Sessões: `qa-student-desktop-20260724` e `qa-student-mobile-test`

## Resumo

| Prioridade | Quantidade |
|---|---:|
| Alta | 4 |
| Média | 5 |
| Baixa | 1 |
| **Total** | **10** |

Os maiores bloqueios são o contrato invisível e sem saída no mobile, o relatório de Evolução retornando HTTP 500, a área de Treinamentos falhando no banco e o contraste quase nulo em áreas importantes do portal.

## Cobertura

| Plataforma | Resolução | Áreas verificadas |
|---|---|---|
| Desktop | 1440 × 900 | Meu Portal, contrato, histórico, notificações, busca, tema, sidebar recolhida, Wolfie Tutor, Praticar, Aulas, Links, Materiais, Financeiro, Evolução, Treinamentos, Indicações e Meu Perfil |
| Mobile | iPhone 12 / 390 × 844 | Menu lateral, Meu Portal, contrato, notificações, tema, Wolfie Tutor, Praticar, Aulas, Links, Materiais, Financeiro, Evolução, Treinamentos, Indicações e Meu Perfil |
| Mobile compacto | 360 × 800 | Financeiro, tabela de mensalidades e comportamento do contrato em viewport estreito |

Restrições respeitadas: somente leitura; nenhum cadastro, edição, exclusão, download, pagamento, mensagem, compartilhamento ou notificação externa foi disparado.

### Console e rede

- A abertura de Evolução disparou `POST /functions/v1/generate-student-insights` e recebeu HTTP 500 em desktop e mobile.
- O gráfico de Evolução gerou aviso de dimensão inválida (`width(-1)` / `height(-1)`).
- Treinamentos registrou erro PostgreSQL `42702`, por referência ambígua à coluna `id`.
- As demais requisições observadas nas áreas cobertas responderam normalmente; não foi encontrado overflow horizontal global nas medições de 390 px e 360 px. Os cortes descritos abaixo ocorrem dentro dos próprios componentes.
- Logs brutos não foram salvos para evitar registrar identificadores, sessão ou dados da conta.

## Achados

### STUDENT-001 — Relatório inteligente de Evolução falha ao abrir

| Campo | Valor |
|---|---|
| **Prioridade** | Alta |
| **Categoria** | Funcional / console / rede |
| **Plataformas** | Desktop e mobile |

**Resultado atual:** ao entrar em Evolução, o sistema tenta gerar automaticamente o relatório, recebe HTTP 500 e exibe “Erro ao gerar novo relatório”. O gráfico também registra aviso de dimensão inválida.

**Esperado:** a tela deveria carregar o último relatório válido ou explicar que ainda não existem dados suficientes, sem executar uma operação que falha.

**Reprodução**

1. Abrir o menu e selecionar **Evolução**.
2. Aguardar o carregamento.
3. Observar o erro no cartão “Relatório Inteligente (IA)” e o HTTP 500 na rede.

**Evidências:** [desktop](screenshots/desktop-evolucao.png) · [mobile](screenshots/mobile-evolucao.png)

---

### STUDENT-002 — Treinamentos mostra falso estado vazio após erro no banco

| Campo | Valor |
|---|---|
| **Prioridade** | Alta |
| **Categoria** | Funcional / dados / console |
| **Plataformas** | Desktop e mobile |

**Resultado atual:** a área exibe “Nenhum treinamento disponível ainda”, mas o console registra erro PostgreSQL `42702`: referência à coluna `id` ambígua. O usuário não consegue distinguir ausência real de treinamentos de uma falha de carregamento.

**Esperado:** carregar os treinamentos corretamente ou mostrar um estado de erro com opção de tentar novamente.

**Reprodução**

1. Abrir **Treinamentos**.
2. Observar o estado vazio.
3. Verificar o erro `42702` no console.

**Evidências:** [desktop](screenshots/desktop-treinamentos.png) · [mobile](screenshots/mobile-treinamentos.png)

---

### STUDENT-003 — Contrato fica invisível e prende o aluno no mobile

| Campo | Valor |
|---|---|
| **Prioridade** | Alta |
| **Categoria** | Funcional / responsividade / acessibilidade |
| **Plataformas** | Mobile 390 px e 360 px |

**Resultado atual:** ao tocar em **Meu Contrato**, a página fica escurecida e desfocada, mas o contrato, o botão de fechar e o download não aparecem visualmente. Tocar no controle de fechamento exposto à árvore de acessibilidade, pressionar Escape e tocar no fundo não encerraram o estado; foi necessário recarregar a página.

**Esperado:** abrir um diálogo legível, rolável, com cabeçalho e botão de fechar sempre visíveis.

**Reprodução**

1. No Meu Portal, tocar em **Meu Contrato**.
2. Observar somente o backdrop escuro, sem conteúdo do diálogo.
3. Tentar fechar pelo controle acessível, pelo fundo e por Escape.
4. Observar que o bloqueio permanece.

**Evidências:** [antes](screenshots/mobile-portal-after-reload.png) · [modal invisível](screenshots/mobile-contrato-plain.png) · [após tentativa de fechar](screenshots/mobile-contrato-close-attempt.png) · [após toque no backdrop](screenshots/mobile-contrato-backdrop-attempt.png)

**Vídeo:** não utilizável; a tentativa de gravação reiniciou o contexto autenticado. A sequência acima foi preservada em screenshots.

---

### STUDENT-004 — Texto e ações ficam brancos sobre cartões quase brancos

| Campo | Valor |
|---|---|
| **Prioridade** | Alta |
| **Categoria** | Visual / acessibilidade |
| **Plataformas** | Desktop e mobile |

**Resultado atual:** títulos e ações importantes ficam praticamente invisíveis no tema claro. Exemplos confirmados:

- nomes dos objetivos no **Wolfie Tutor**;
- título, descrição e “COPIAR LINK” em **Links**;
- cabeçalhos em **Financeiro**;
- cartão do relatório inteligente em **Evolução**.

**Esperado:** contraste compatível com WCAG AA e estados de botão visualmente distinguíveis.

**Reprodução**

1. Manter o tema claro.
2. Abrir Wolfie Tutor, Links, Financeiro ou Evolução.
3. Observar texto branco ou muito claro sobre superfícies brancas/cinza-claro.

**Evidências:** [Wolfie mobile](screenshots/mobile-wolfie-tutor-plain.png) · [Wolfie desktop](screenshots/desktop-wolfie-tutor.png) · [Links mobile](screenshots/mobile-links-plain.png) · [Links desktop](screenshots/desktop-links.png) · [Financeiro mobile](screenshots/mobile-financeiro.png)

---

### STUDENT-005 — Gráfico de competências é cortado no mobile

| Campo | Valor |
|---|---|
| **Prioridade** | Média |
| **Categoria** | Responsividade / visualização de dados |
| **Plataformas** | Mobile 390 px |

**Resultado atual:** os rótulos laterais do radar ficam cortados (“Vocabulary” e “Listening”), a legenda inferior trunca “Vocabulary” e o tooltip ocupa parte relevante do gráfico. Não há scroll horizontal global que permita recuperar o conteúdo.

**Esperado:** reduzir o radar, reposicionar os rótulos ou usar uma visualização alternativa no mobile.

**Evidência:** [gráfico mobile](screenshots/mobile-evolucao.png)

---

### STUDENT-006 — Ação de salvar perfil sobrepõe conteúdo e não tem nome acessível

| Campo | Valor |
|---|---|
| **Prioridade** | Média |
| **Categoria** | Responsividade / acessibilidade |
| **Plataformas** | Mobile 390 px |

**Resultado atual:** “Salvar alterações” vira um botão flutuante somente com ícone, sem nome acessível, posicionado sobre a área “Informações Pessoais”. O usuário precisa deduzir a função e o botão compete com o conteúdo do formulário.

**Esperado:** botão rotulado, integrado ao fluxo do formulário e sem sobreposição.

**Evidências:** [mobile](screenshots/mobile-perfil.png) · [referência desktop](screenshots/desktop-perfil.png)

---

### STUDENT-007 — Popover de notificações ultrapassa o lado esquerdo da tela

| Campo | Valor |
|---|---|
| **Prioridade** | Média |
| **Categoria** | Responsividade / UX |
| **Plataformas** | Mobile 390 px |

**Resultado atual:** ao abrir notificações, o popover se ancora como no desktop, excede o viewport pela esquerda e corta parte do título “Pendências”. O painel também cobre grande parte do conteúdo.

**Esperado:** painel alinhado às margens do viewport ou apresentado como sheet/dialog mobile.

**Reprodução**

1. Tocar no sino.
2. Observar o painel deslocado para fora da tela.

**Evidência:** [notificações mobile](screenshots/mobile-notificacoes.png)

---

### STUDENT-008 — Tabela financeira perde colunas e mensagem em 360 px

| Campo | Valor |
|---|---|
| **Prioridade** | Média |
| **Categoria** | Responsividade / UX |
| **Plataformas** | Mobile 360 × 800 |

**Resultado atual:** somente as primeiras colunas aparecem; “Status” e “Ação” ficam fora da área visível. A mensagem de estado vazio também é cortada e não existe indicação clara de que a tabela pode exigir gesto horizontal.

**Esperado:** cartões por mensalidade no mobile ou scroll horizontal explícito, com affordance e texto completo.

**Evidências:** [topo](screenshots/mobile360-financeiro-top.png) · [tabela](screenshots/mobile360-financeiro-table.png)

---

### STUDENT-009 — Busca global e “Ver tudo” não produzem resultado

| Campo | Valor |
|---|---|
| **Prioridade** | Média |
| **Categoria** | Funcional / UX |
| **Plataformas** | Desktop |

**Resultado atual:** digitar “financeiro” na busca e pressionar Enter não abre resultado, sugestão ou estado vazio. O botão **Ver tudo** do histórico também foi acionado repetidamente sem navegação, expansão ou feedback.

**Esperado:** controles funcionais ou remoção até que a funcionalidade esteja disponível.

**Evidências:** [busca após Enter](screenshots/desktop-busca.png) · [histórico após “Ver tudo”](screenshots/desktop-historico-ver-tudo.png)

---

### STUDENT-010 — Sidebar recolhida remove nomes acessíveis de ações críticas

| Campo | Valor |
|---|---|
| **Prioridade** | Baixa |
| **Categoria** | Acessibilidade |
| **Plataformas** | Desktop |

**Resultado atual:** após recolher a sidebar, os controles de sair e expandir são expostos como botões sem nome. Usuários de leitor de tela não conseguem identificar as ações.

**Esperado:** manter `aria-label`/nome acessível mesmo quando o texto visual é ocultado.

**Evidência:** [sidebar recolhida](screenshots/desktop-sidebar-recolhida.png)

## Ordem recomendada de correção

1. Corrigir o modal do contrato no mobile e garantir fechamento por botão, backdrop e Escape.
2. Corrigir o erro `42702` de Treinamentos e o HTTP 500 do relatório de Evolução.
3. Revisar os tokens/estilos de contraste usados nos cartões claros.
4. Criar variantes mobile para radar, tabela financeira, notificações e ação de salvar perfil.
5. Conectar ou remover temporariamente os controles sem ação.
6. Completar nomes acessíveis e validar teclado/leitor de tela.
