# Auditoria exploratória — Professor

Data: 2026-07-24
Ambiente: produção
Escopo: todas as áreas acessíveis ao perfil `TEACHER`, em desktop e mobile.

## Resumo

| Prioridade | Quantidade |
|---|---:|
| Alta | 4 |
| Média | 6 |
| Baixa | 0 |
| **Total** | **10** |

Os principais bloqueios são a navegação mobile que pode abrir vazia, as telas
Financeiro e Notas Fiscais ilegíveis em viewport estreito, o contrato com
largura fixa de desktop e as falhas silenciosas de Wolfie Lab e Treinamentos.

## Cobertura

- Desktop 1440×900: 21 telas — Dashboard, Lançar Aula, Pendentes, Links de Aula,
  Alunos, Planner IA, Wolfie Lab, Skills da Turma, Mensagens, Saída/Ausência,
  Agenda, Notas Fiscais, Financeiro, Reposições, Pedagógico, Treinamentos,
  Testes Orais, Smart, Indicações, Meu Contrato e Meu Perfil.
- Mobile iPhone 12, 390×844: as mesmas 21 telas.
- Spot-check 360×800: Dashboard, Financeiro e Notas Fiscais.
- Limites de segurança: nenhuma criação, edição, exclusão, assinatura, envio de mensagem ou disparo de notificação.

### Console e rede

- Wolfie Lab: HTTP 400, `PGRST200`, por relacionamento indisponível no cache de
  esquema.
- Treinamentos: erro PostgreSQL `42702`, por referência ambígua à coluna `id`.
- Nas demais telas cobertas não foi observada falha de carregamento.
- Logs brutos não foram preservados para evitar registrar sessão ou dados da
  conta.

## Achados

### TEACHER-001 — Wolfie Lab falha ao carregar o histórico

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Média |
| Categoria | Funcional / console / tratamento de erro |
| Ambiente | Desktop 1440×900 |
| Evidência | [desktop-wolfie-lab.png](screenshots/desktop-wolfie-lab.png) |
| Vídeo | N/A — erro ocorre no carregamento |

**Descrição**

Ao abrir **Wolfie Lab**, a consulta de sessões retorna HTTP 400. O console registra `PGRST200`: a API não encontra o relacionamento solicitado entre `wolfie_sessions` e `student_id` no cache de esquema. A tela permanece sem histórico e não informa ao professor que houve falha; o estado vazio pode ser confundido com ausência real de sessões.

**Reprodução**

1. Entrar como Professor.
2. Abrir **Wolfie Lab** pelo menu.
3. Observar a tela sem histórico na evidência acima.
4. Conferir console/rede: requisição de `wolfie_sessions` retorna HTTP 400 com `PGRST200`.

**Esperado**

O histórico deve carregar normalmente. Se a API falhar, a interface deve informar o problema e oferecer uma tentativa de recarregamento.

### TEACHER-002 — Rodapé da barra lateral sobrepõe módulos no desktop

| Campo | Valor |
|---|---|
| Prioridade | P2 |
| Severidade | Média |
| Categoria | Responsividade / navegação |
| Ambiente | Desktop 1440×900 |
| Evidências | [desktop-lancar-aula.png](screenshots/desktop-lancar-aula.png), [issue-teacher-002-financeiro-result.png](screenshots/issue-teacher-002-financeiro-result.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

Em 1440×900, a seção fixa da conta (`Meu Perfil`, `Sair`, `Recolher`) ocupa a mesma faixa vertical dos últimos itens do menu. `Financeiro` fica sem rótulo visível e `Reposições`, `Pedagógico`, `Treinamentos`, `Testes Orais`, `Smart`, `Indicações` e `Meu Contrato` permanecem atrás do rodapé ou fora da área útil no estado inicial. A região pode ser rolada, mas não há barra, gradiente ou outro indício visual de continuação.

O problema não é apenas cosmético: ao tentar acionar o nó oculto de `Financeiro`, a tela permaneceu/retornou ao Dashboard, pois o alvo visual útil estava encoberto. Depois de rolar deliberadamente a barra lateral, o destino passou a funcionar.

**Reprodução**

1. Entrar como Professor em um viewport 1440×900.
2. Observar a barra lateral até `Notas Fiscais`.
3. Verificar que a área `CONTA` começa antes dos demais módulos e os encobre.

**Esperado**

Todos os módulos devem ficar acessíveis em uma região rolável própria, sem sobreposição do rodapé da conta, com indicação clara de rolagem; o item ativo deve exibir rótulo e destino coerentes.

### TEACHER-003 — Treinamentos exibe vazio quando a consulta falha

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Média |
| Categoria | Funcional / console / tratamento de erro |
| Ambiente | Desktop 1440×900 |
| Evidência | [desktop-treinamentos.png](screenshots/desktop-treinamentos.png) |
| Vídeo | N/A — erro ocorre no carregamento |

**Descrição**

Ao abrir **Treinamentos**, o console registra erro PostgreSQL `42702` (`column reference "id" is ambiguous`). Mesmo com a falha da consulta, a interface afirma **“Nenhum treinamento disponível ainda”**, induzindo o professor a acreditar que a escola não publicou conteúdo.

**Reprodução**

1. Entrar como Professor.
2. Abrir **Treinamentos**.
3. Observar o estado vazio da evidência.
4. Conferir o console: `Training load error`, código `42702`.

**Esperado**

A consulta deve retornar os treinamentos atribuídos. Em falha, a tela deve distinguir erro de ausência de conteúdo e permitir tentar novamente.

### TEACHER-004 — Botão “COPIAR” quebra letra por letra no Dashboard mobile

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Média |
| Categoria | Responsividade / visual |
| Ambiente | iPhone 12, 390×844 |
| Evidência | [mobile-dashboard-copy-break.png](screenshots/mobile-dashboard-copy-break.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

No cartão do programa de indicação, o campo do link ocupa quase toda a linha e comprime o botão `COPIAR` até aproximadamente a largura de uma letra. O rótulo é quebrado em cinco linhas (`C / OP / IA / R`), tornando a ação difícil de reconhecer e tocar. O documento não cria rolagem horizontal (`scrollWidth = innerWidth = 390`); o problema é a distribuição interna da linha.

**Reprodução**

1. Abrir o Dashboard do Professor em iPhone 12.
2. Rolar até **Programa de indicação**.
3. Observar a ação `COPIAR` na evidência.

**Esperado**

Empilhar link e botão no mobile ou reservar ao botão uma largura mínima que mantenha o rótulo em uma linha e área de toque adequada.

### TEACHER-005 — Menu mobile abre vazio quando acionado após rolar a página

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Alta |
| Categoria | Responsividade / navegação |
| Ambiente | iPhone 12, 390×844 |
| Evidências | [mobile-menu-open.png](screenshots/mobile-menu-open.png), [mobile-menu-open-at-top.png](screenshots/mobile-menu-open-at-top.png) |
| Vídeo | N/A — sequência comprovada por capturas antes/depois |

**Descrição**

Quando o professor rola o Dashboard para a região do programa de indicação e abre o menu hambúrguer, aparece um painel branco sem opções. O mesmo menu funciona quando a página está no topo. Como o Dashboard mobile é muito longo, esse estado bloqueia a navegação exatamente onde o menu é mais necessário.

**Reprodução**

1. Abrir o Dashboard em iPhone 12.
2. Rolar para a região do programa de indicação (`scrollY` observado: 2338).
3. Tocar no botão de menu.
4. Observar o painel vazio em [mobile-menu-open.png](screenshots/mobile-menu-open.png).
5. Fechar o painel, voltar ao topo e abrir o menu novamente.
6. Observar as opções renderizadas em [mobile-menu-open-at-top.png](screenshots/mobile-menu-open-at-top.png).

**Esperado**

O drawer deve usar posicionamento relativo ao viewport e sempre iniciar em uma posição válida, independentemente da rolagem da página subjacente.

### TEACHER-006 — Ação “SALVAR” fica quebrada e comprimida em Mensagens

| Campo | Valor |
|---|---|
| Prioridade | P2 |
| Severidade | Média |
| Categoria | Responsividade / visual |
| Ambiente | iPhone 12, 390×844 |
| Evidência | [mobile-mensagens.png](screenshots/mobile-mensagens.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

Na base da configuração de lembrete, o texto explicativo e o botão dividem a mesma linha. O botão é comprimido e o rótulo `SALVAR` quebra em duas linhas (`SAL / VAR`). A ação principal perde legibilidade e área útil apesar de haver largura disponível quando os elementos são empilhados.

**Esperado**

No mobile, posicionar a explicação acima e usar um botão de largura total ou mínima suficiente para manter `SALVAR` em uma linha.

### TEACHER-007 — Tabela de Notas Fiscais corta colunas e palavras no mobile

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Alta |
| Categoria | Responsividade / visual / acesso à informação |
| Ambiente | iPhone 12, 390×844 |
| Evidência | [mobile-notas-fiscais.png](screenshots/mobile-notas-fiscais.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

A tabela mantém o formato de desktop dentro de um cartão estreito. Cabeçalhos quebram no meio das palavras (`REFERÊN / CIA`, `AUL / AS`), apenas as primeiras colunas ficam visíveis e `STATUS` e `AÇÃO / ARQUIVO` não aparecem na captura. O estado vazio também fica cortado na borda direita. A página não apresenta rolagem horizontal global (`scrollWidth = innerWidth = 390`) nem indicação de que existe conteúdo lateral.

**Esperado**

Substituir a tabela por cartões no mobile ou implementar uma área horizontal rolável com affordance clara, preservando todas as colunas e palavras inteiras.

### TEACHER-008 — Financeiro colapsa títulos e controles em colunas de uma letra

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Alta |
| Categoria | Responsividade / visual / acesso à informação |
| Ambiente | iPhone 12, 390×844 |
| Evidência | [mobile-financeiro.png](screenshots/mobile-financeiro.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

Na tela **Financeiro**, o título, a descrição e a ação `Meu Relatório (PDF)` são comprimidos até aproximadamente a largura de uma letra e passam a ocupar dezenas de linhas. O seletor de mês perde alinhamento e a tabela exibe apenas uma parte das colunas. Não existe rolagem horizontal no documento (`scrollWidth = innerWidth = 390`), portanto os controles não estão apenas fora da captura: a composição interna do cabeçalho efetivamente colapsa.

**Reprodução**

1. Entrar como Professor em iPhone 12.
2. Abrir **Financeiro** pelo menu.
3. Observar o cabeçalho, o seletor de período e o início da tabela na evidência.

**Esperado**

Empilhar título, descrição, período e ação no mobile; preservar palavras inteiras, áreas de toque adequadas e acesso a todas as informações financeiras, preferencialmente em cartões ou em uma tabela com rolagem interna claramente indicada.

### TEACHER-009 — Contrato usa largura fixa de desktop e corta o documento legal

| Campo | Valor |
|---|---|
| Prioridade | P1 |
| Severidade | Alta |
| Categoria | Responsividade / acesso a documento |
| Ambiente | iPhone 12, 390×844 |
| Evidência | Medição do DOM e inspeção visual; captura não versionada por conter dados pessoais do documento |
| Vídeo | N/A — falha estática de layout |

**Descrição**

A área impressa do contrato mantém elementos internos com `605 px` e `794 px`
de largura em uma viewport de `390 px`. O documento raiz permanece limitado à
largura da tela e não oferece rolagem horizontal global; assim, cabeçalho,
qualificação das partes, cláusulas e assinaturas ficam cortados. Os botões de
PDF aparecem, mas a leitura do contrato no próprio sistema não é possível no
celular.

**Esperado**

O contrato deve usar uma versão responsiva para leitura, com texto fluido e
sem perda lateral. O layout fixo de impressão pode ser mantido somente dentro
do arquivo/PDF, separado da visualização mobile.

### TEACHER-010 — Salvar perfil vira botão flutuante sem nome acessível

| Campo | Valor |
|---|---|
| Prioridade | P2 |
| Severidade | Média |
| Categoria | Responsividade / acessibilidade |
| Ambiente | iPhone 12, 390×844 |
| Evidência | [mobile-meu-perfil.png](screenshots/mobile-meu-perfil.png) |
| Vídeo | N/A — falha estática de layout |

**Descrição**

Em **Meu Perfil**, a ação de salvar é reduzida a um ícone flutuante sobre o
cartão de informações pessoais. O botão não possui nome acessível na árvore
inspecionada e compete visualmente com o conteúdo do formulário.

**Esperado**

Usar uma ação rotulada e integrada ao formulário, preservando nome acessível,
ordem de foco e espaço próprio no mobile.

## Ordem recomendada de correção

1. Corrigir o drawer mobile e a composição de Financeiro e Notas Fiscais.
2. Tornar a leitura do contrato responsiva, mantendo o layout fixo apenas no
   PDF.
3. Corrigir Wolfie Lab e a consulta de Treinamentos, distinguindo erro de
   estado vazio.
4. Reestruturar a rolagem da sidebar desktop e impedir a sobreposição do
   rodapé.
5. Ajustar ações comprimidas e completar nomes acessíveis.
