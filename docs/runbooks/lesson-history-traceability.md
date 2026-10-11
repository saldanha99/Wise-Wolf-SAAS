# Histórico de aulas, transparência e rastreabilidade

Implementação da Parte 2, preparada em 10/10/2026. Não publicada por esta tarefa.

## Acesso

- Professor: menu **Histórico de aulas**, botão de conferência em **Saída / Ausência** e aba de aulas na ficha de seu aluno.
- Direção: **Qualidade das aulas → Histórico de aulas**. Coordenação: **Histórico de aulas** no menu. Selecionar um teacher, inclusive encerrado.
- Após encerramento: **/historico-prestacao**, acessível também pelo login. Exige autenticação com a própria conta; autoriza somente os registros da prestação. Não restaura membership, acesso operacional, ficha, dossiê ou financeiro. Conta suspensa não recebe esta exceção. Conta apagada/bloqueada no provedor Auth requer atendimento de acesso da escola.

## Fontes e categorias

`class_logs` é a fonte de realização/falta. `lesson_quality_sources` usa a agenda efetiva (versões, antecipações e coberturas), com identidade da ocorrência, para futuras e não finalizadas. Cada linha corresponde à unidade registrada; duas partes de uma hora permanecem duas linhas. Reposição realizada é categoria separada de realizada regular.

O passivo de `reschedules` sem `used_at`, sem encerramento e sem lançamento aparece separadamente, inclusive sem data e anterior ao período. Não é somado duas vezes às categorias de ocorrências. Os eventos canônicos de `reschedule_events` são consultados, inclusive os anteriores ao módulo.

Feriado e cancelamento pelo teacher são decisões explícitas da direção/coordenação para uma ocorrência de booking sem lançamento nem antecipação consumida; excluem somente essa data. Reabrir uma classificação equivocada exige outra correção justificada e versionada, com remoção auditada da exclusão. Não se infere feriado pelo texto do motivo nem se atribui falta a um appointment `no_show` sem prova do responsável. Exclusões antigas aparecem como excluídas com o motivo até receberem uma classificação explícita. Status legado não reconhecido aparece como não finalizado para revisão, sem reescrever presença.

A transferência de booking passa a preservar as pendências anteriores para o teacher que constava na versão antiga. O novo teacher não herda ocorrências anteriores ao momento da transferência. Isso depende de prova disponível: não se inventa a titularidade anterior de agendamentos transferidos antes da implantação da trilha.

## Integridade e divergências

- Auditoria prospectiva em `private.lesson_history_events`: criação, alteração, remoção, valores anterior/atual, ator quando conhecido e motivo quando fornecido pela origem. Captura `class_logs`, `bookings`, `reschedules`, `appointments`, versões de agenda e exclusões.
- Eventos não aceitam UPDATE/DELETE, nem acesso direto pelas funções da API. Remoções de lançamentos permanecem visíveis e não ressurgem como aula nunca registrada. Reatribuições de lançamento permanecem na conferência anterior como reatribuídas, sem contá-las como realizadas daquele teacher.
- Baseline único dos lançamentos anteriores. A data original de criação é preservada; não se inventam autoria ou alterações passadas. Rotinas antigas que não fornecem justificativa são identificadas como tal.
- Correções operacionais: apenas direção/coordenação; justificativa de 10–1000 caracteres, observações até 1000 e versão esperada. Não alteram o lançamento original, presença, valores, folha ou aprovação do Meet. Divergências financeiras seguem pela Central de Qualidade e pela régua oficial existente.
- Teacher e gestão podem abrir contestação; apenas gestão resolve. Abertura e resolução ficam registradas, com responsáveis e datas. Não há desconto, multa ou liberação de pagamento automática.

## Conferência e exportação

Filtros por mês (qualquer mês), intervalo (até 3660 dias) e aluno. **Toda a prestação / encerramento** começa na origem mais antiga disponível e inclui agenda até 90 dias à frente, alunos com vínculos atuais/históricos, última atividade registrada, passivo, contestações e eventos. Não conclui o encerramento.

**Baixar relatório para arquivamento** gera HTML autossuficiente. **Imprimir / salvar PDF** usa a impressão do navegador. O documento respeita os filtros atuais e inclui referências das linhas para conferir os totais. Nomes, motivos, observações e snapshots são escapados para impedir execução de HTML no arquivo.

## Privacidade e retenção

Novas tabelas são privadas, com RLS e sem grants de leitura/escrita à API. RPCs conferem usuário, papel, vínculo e escola no servidor. A exceção de leitura pós-encerramento é limitada ao próprio teacher com estado `offboarded` e membership TEACHER revogada; outros papéis/teachers/escolas são recusados. A consulta não amplia a RLS dos perfis ou do dossiê.

A auditoria usa projeção fechada operacional: não copia telefone, CPF, e-mail, PIX, valores, transcrições, resumo do Meet ou dados do cartão pedagógico. Formulários orientam registrar fatos sem dados sensíveis. Arquivos exportados devem ficar em armazenamento protegido da escola.

Não foi definido prazo jurídico novo de retenção nem limpeza automática de evidências contratuais. A escola deve documentar sua política, finalidade e prazo e autorizar um procedimento de expurgo específico; o prazo de 90 dias das fontes do Meet não foi reaproveitado para registros operacionais/contratuais. Esta entrega não declara aprovação jurídica ou conformidade LGPD integral.

## Publicação e validação

Migration `20261010232456_lesson_history_traceability.sql` e teste `supabase/tests/lesson_history_traceability.sql` registrados no release oficial. Tour `2026-10-10-historico-aulas-rastreavel` para professor, direção e coordenação; coordenação recebe novidades sem criar um tour de boas-vindas para seu papel.

Validação de banco: cópia só de estrutura na VPS, dados fixture com notificações suprimidas e rollback; migration aplicada duas vezes. A restauração por postgres não consegue restaurar os defaults de supabase_admin: reproduzir somente os ALTER DEFAULT PRIVILEGES usando supabase_admin no clone, excluindo o schema cron ausente, antes da suíte de segurança. Nenhuma migration desta entrega deve ser aplicada manualmente em produção.

Testes cobrem escopo, leitura pós-encerramento sem acesso operacional, versão concorrente, original preservado, contestação/resolução, feriado exclusivo, passivo sem data, remoção auditada e pendências na transferência. Regressões: histórico de antecipações, troca de horário, sugestões de lançamento do Meet e hardening de SECURITY DEFINER. UI: filtros, erros, contestação/correção, autenticação dedicada, exportação segura e tours. Conferência visual com dados fictícios em desktop e viewport 390 px.
