# Auditoria de fluxos e responsividade por perfil

Data: 2026-07-24
Ambiente: produção (`https://system.wisewolflanguage.com.br`)
Perfis: diretor (`SCHOOL_ADMIN`), professor (`TEACHER`) e aluno (`STUDENT`)
Viewports: desktop 1440 × 900 e mobile iPhone 12

## Resultado executivo

Auditoria concluída em produção com identidades de QA isoladas e notificações
externas desativadas. Foram catalogados **29 achados por perfil** — algumas
causas aparecem em mais de um perfil — além de uma falha crítica de permissão
descoberta e corrigida antes do início da navegação.

| Prioridade | Diretor | Professor | Aluno | Total |
|---|---:|---:|---:|---:|
| Alta | 7 | 4 | 4 | **15** |
| Média | 2 | 6 | 5 | **13** |
| Baixa | 0 | 0 | 1 | **1** |
| **Total** | **9** | **10** | **10** | **29** |

O login público está responsivo nas três resoluções verificadas. Os maiores
riscos estão dentro das áreas autenticadas: falhas de dados mascaradas como
estado vazio, navegação lateral sobreposta, contratos impraticáveis no mobile,
tabelas de desktop comprimidas e contraste insuficiente no portal do aluno.

## Cobertura

- [Relatório do diretor](director/report.md)
- [Relatório do professor](teacher/report.md)
- [Relatório do aluno](student/report.md)
- [Relatório do acesso público](global/report.md)

| Perfil | Desktop 1440×900 | iPhone 12 390×844 | Spot-check 360×800 |
|---|---:|---:|---:|
| Diretor | 34 telas | 34 telas | 5 telas críticas |
| Professor | 21 telas | 21 telas | Dashboard, Financeiro e Notas Fiscais |
| Aluno | 17 áreas/estados | 15 áreas/estados | Financeiro, contrato e perfil |
| Acesso público | Login | Login | Login |

Foram exercitadas navegação, abertura de menus, modais, tabelas, estados vazios
e carregamento de dados. Não foram executados cadastro, edição, exclusão,
assinatura, pagamento, download, compartilhamento, envio de WhatsApp ou
disparo de notificação.

## Correção crítica realizada durante a preparação

O primeiro login de uma conta de QA autenticou corretamente, mas o Data API
respondeu `403` ao consultar a nova coluna `profiles.is_test_account`. A coluna
participa da projeção autenticada do perfil, porém não tinha privilégio
explícito de `SELECT`.

Foi criada e aplicada a migração
`20260724144719_grant_test_account_profile_read.sql`, limitada ao papel
`authenticated`. As políticas RLS existentes continuam determinando quais
linhas cada usuário pode acessar. O login foi repetido com sucesso após a
correção.

## Melhorias recomendadas

1. **Corrigir primeiro as falhas funcionais e de autorização**
   - Wolfie Lab retorna HTTP 400 para Diretor e Professor.
   - Treinamentos falha com PostgreSQL `42702` para Professor e Aluno.
   - Evolução do aluno retorna HTTP 500.
   - Testes Orais do Diretor retorna HTTP 403 ao consultar professores.
   - Acolhimento (Docs) abre a gestão de notas fiscais de professores.

2. **Reestruturar a navegação compartilhada**
   - A sidebar desktop precisa de uma região rolável independente, sem o
     rodapé sobreposto.
   - O drawer mobile deve se posicionar pelo viewport e abrir corretamente
     mesmo depois de a página ser rolada.
   - Menus recolhidos e botões de ícone devem manter nomes acessíveis e
     tooltips.

3. **Criar componentes realmente mobile**
   - Contratos devem ter leitura fluida no celular; o formato fixo fica apenas
     no PDF.
   - Tabelas financeiras/administrativas devem virar cartões ou áreas roláveis
     com indicação clara.
   - Mapa de Aulas, cabeçalhos, abas e ações precisam empilhar sem quebrar
     palavras em colunas.
   - Modais, popovers e botões flutuantes devem respeitar limites do viewport.

4. **Revisar o sistema visual e o feedback de erro**
   - Corrigir tokens de contraste usados em Wolfie, Links, Financeiro e
     Evolução do aluno.
   - Nunca apresentar “nenhum item” quando a consulta falhou; mostrar erro,
     contexto e ação de tentar novamente.
   - Conectar ou retirar temporariamente busca, “Ver tudo” e outros controles
     que não produzem resultado.

## Ordem sugerida de implementação

### Lote 0 — Dados e rotas

Corrigir Wolfie Lab, Treinamentos, Evolução, Testes Orais e o destino de
Acolhimento. Adicionar estados de erro e testes de integração para não voltar
a mascarar falhas como listas vazias.

### Lote 1 — Estrutura responsiva compartilhada

Corrigir sidebar, drawer, modal de contrato, popover de notificações e o
componente comum de perfil. Esse lote resolve problemas repetidos nos três
papéis com menos alterações isoladas.

### Lote 2 — Telas densas e acabamento

Aplicar variantes mobile para tabelas, Mapa de Aulas, gráficos e ações; revisar
contraste, rótulos acessíveis, áreas de toque e controles sem ação.

## Evidências e observações

- Cada relatório por perfil contém passos, resultado esperado e capturas
  sanitizadas.
- Capturas de contratos que exibiam dados pessoais não fazem parte do conjunto
  a ser versionado; o defeito foi documentado por medição do layout.
- O teste utilizou somente registros marcados como fixture, em uma unidade
  isolada e sem integração externa ativa.
- A identidade reutilizável e as regras de segurança para novos testes estão
  registradas no [runbook de identidades E2E](../../runbooks/e2e-test-identities.md).
- Após a auditoria, as três identidades, a unidade e todos os registros
  associados à fixture foram removidos. As verificações finais retornaram zero
  para usuários, perfis, pagamentos, filas, notificações e logs.
- Nenhuma cobrança Asaas ou comunicação WhatsApp foi criada. Um resumo
  sanitizado foi preservado na VPS em
  `/opt/wisewolf/backups/qa-responsive-20260724/fixture-summary.json`, com
  acesso restrito ao administrador.
