# Auditoria de contratos dos alunos — 08/09/2026

## Conclusão

Não é possível aprovar os contratos como 100% corretos. A leitura do código local e a consulta somente de leitura ao banco de produção demonstraram inconsistências na geração dos documentos. Não foram alterados contratos, cadastros ou dados financeiros.

## Escopo e método

Consultas em transações READ ONLY via conexão de implantação existente. Universo: profiles com role STUDENT e test_fixture_key nulo; essa exclusão depende da marcação correta das contas de teste. Foram encontrados 58 cadastros, dos quais 42 ativos. O código local não foi comparado byte a byte com o pacote publicado. Não foi realizado login nas contas reais dos alunos. Os PDFs anexados foram verificados quanto à existência e regra de acesso, mas não tiveram seu conteúdo revisado individualmente. A auditoria é técnica e de consistência de dados, sem conclusão sobre validade jurídica das cláusulas.

## Resultados nos alunos ativos

- 42 ativos; 34 com contract_accepted verdadeiro; 11 com PDF anexado e 31 sujeitos à geração pelo portal.
- Nenhuma data de criação ou aceite preenchida anterior a 2000 ou posterior à consulta.
- Dos 31 sem PDF: 3 sem mensalidade positiva; 3 sem dia de vencimento; 26 com fidelity_plan ausente ou fora de ANNUAL/SEMESTER/RECURRENT. O módulo também pode influenciar a duração, portanto esse último número não significa 26 contratos comprovadamente com prazo errado.
- Aplicando o cálculo das telas aos dados atuais, 8 dos 31 apresentam início de vigência diferente entre administração e portal. A administração usa accepted_at, com fallback para hoje; o aluno usa created_at. Os 8 também não têm accepted_at. Isso não prova assinatura ausente em documentos externos nem representa 8 contratos digitais aceitos com data faltante.
- Um dos 31 é interpretado pelo portal como semestral; a administração gera sempre 12 meses, inclusive no valor total.
- Dos 20 sem PDF com asaas_subscription_end_date disponível, 7 apresentam término calculado pelo portal diferente de fim_do_servico(asaas_subscription_end_date), regra financeira do próprio banco. É uma divergência a reconciliar com o documento original e o acordo comercial, não prova isolada de qual data está correta. Não foi consultada diretamente a API Asaas.
- No universo completo, 42 contratos estão marcados como aceitos e todos têm accepted_at. Esse grupo não equivale aos 42 alunos ativos.
- student_contracts não contém registros vinculados ao universo analisado; tenant_contract_records está vazia. Esses repositórios não fornecem uma versão histórica congelada para a reconciliação.

## Falhas no código

1. components/ContractManagement.tsx:273–288 calcula a partir do aceite e fixa 12 meses. components/ContractView.tsx:198–205 calcula a partir da criação e identifica apenas algumas opções de plano.
2. lib/contractDates.ts usa hoje quando a referência falta. Uma vigência administrativa pode mudar conforme o dia da consulta.
3. ContractView transforma mensalidade ausente em zero e vencimento ausente em dia 1, produzindo dados contratuais sem confirmação do acordo original.
4. contractPeriod não limita o dia inicial ao último dia do mês. Reprodução em America/Sao_Paulo: referência 10/02/2026, vencimento 31, prazo 6 meses resulta em 03/03/2026 a 03/09/2026. O helper de soma de meses limita o término, mas não resolve essa construção inicial.
5. ContractDocument usa a data atual no rodapé quando acceptedAt falta. Deve ser distinguido documento pendente de documento efetivamente assinado.
6. O portal gera documentos usando cadastro e template atuais quando contract_url falta; não consulta as tabelas de snapshot examinadas. Não há garantia, por esse caminho, de reprodução exata do texto originalmente aceito.

## Acesso do aluno

StudentDashboard exibe Meu Contrato, Assinar Contrato ou Revise e corrija seu contrato conforme o status, e abre ContractView. Há Baixar PDF no modal; anexos têm Abrir PDF, incluindo alternativa para celular.

O banco permite que get_authorized_profile_private retorne os dados privados ao próprio titular. O bucket contracts é privado. Os 15 anexos do universo completo existem em storage.objects, e todos usam o ID do aluno na posição exigida por contracts_scoped_select; 11 são de alunos ativos. ContractView solicita URL temporária para esses arquivos.

Isso confirma implementação e compatibilidade dos caminhos com a política de acesso, mas não certifica abertura/download ponta a ponta em todos os dispositivos, integridade binária de cada arquivo ou conteúdo de cada PDF. O download de documentos gerados também depende do cadastro obrigatório da escola.

## Validação executada

11 testes existentes passaram: lib/contractDates.test.ts e components/ContractDocument.test.ts. O caso de vencimento 31 em fevereiro foi reproduzido separadamente e evidencia uma lacuna na cobertura atual.

## Correções indicadas

Unificar os dados contratuais usados pelas telas; reconciliar vigência e prazo com os contratos originais e a cobrança; impedir datas/valores inventados por fallback; preservar versão imutável do documento aceito; corrigir início em meses curtos; revisar os PDFs originais e testar visualização/download com uma identidade de teste isolada. Não substituir documentos assinados automaticamente nem inferir condições comerciais ausentes.
