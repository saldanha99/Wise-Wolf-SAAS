# Qualidade e acompanhamento do atendimento comercial

## Escopo autorizado

Implementar os cinco pontos solicitados: fila da coordenação, lembrete único ao professor após 30 minutos, alternativas coerentes com agenda e preferências, acompanhamento por etapa e painel de qualidade.

Pacote publicado: `20260906T173847Z-362cafb371c9`. Ativação e verificações finais registradas abaixo.

## Comportamento

- CRM → **Qualidade da IA**: indicadores de 7/30 dias e fila atual com motivo, tempo de espera, responsável, filtro e abertura da conversa. Acesso validado por vínculo ativo e papel de gestão/comercial da escola. Professores, usuários sem vínculo e outras escolas não acessam o relatório.
- Assumir o atendimento pausa a IA. A operação usa a mesma ordem de bloqueios da fila; invalida uma geração ainda sem efeitos e recusa intervenção durante envio ativo. Outro operador não pode tomar uma atribuição ativa. Concluir a revisão reconhece o caso, libera a IA e não repete mensagens antigas. Novos eventos podem recolocar o contato na fila.
- Convite genérico: substitui o reenvio amplo aos 20 minutos por um lembrete aos 30–60 minutos, somente aos professores elegíveis para o horário. Remarcação: lembra somente o professor responsável, com o código do pedido original. Cada destinatário tem reserva persistente por solicitação/rodada; o estado é reconsultado antes do envio. Aceite, expiração e falhas ambíguas não provocam nova tentativa automática do mesmo lembrete.
- Alternativas: consulta única no servidor considera professores ativos, data futura, disponibilidade, aulas, remarcações, coberturas e reservas financeiras de grade. O atendimento exclui domingos/feriados nacionais e prioriza os dias/períodos informados, respeitando exclusões e restrições reconhecidas. Oferece até duas opções, sempre sujeitas ao aceite. A agenda só é alterada pela confirmação autoritativa existente.
- Preferências explicitamente informadas são preservadas em `weekly_availability` e reaproveitadas no atendimento. Após experimental registrada, a conversa passa a tratar experiência e próximos passos, sem oferecer outra experimental. Dúvidas durante matrícula em processamento vão para a coordenação, sem promover o lead prematuramente a matriculado.
- Follow-ups separam qualificação, pós-experimental e auxílio à matrícula em andamento. Máximo de dois por etapa, com intervalo mínimo de 20 horas desde a conversa recente; o pós-experimental também aguarda 20 horas desde a mudança de etapa. As novas etapas não retomam conversas sem saída há mais de 14 dias. Pedidos aguardando professor, matrícula concluída, conversa em processamento e atendimento humano continuam protegidos. O lembrete pré-aula existente foi preservado.
- Indicadores distinguem textos **possivelmente** repetidos, envios recusados/incertos e mensagens aceitas pelo provedor. Aceitação pelo provedor não significa leitura. Conversões usam os contatos atendidos pela IA que entraram no período e a matrícula autoritativa; a fila é atual. Tempo médio de aceite considera registros de experimental e remarcação ligados ao atendimento da IA.

## Validação

- 97 testes Deno: conversas, fila, envio, prazo de aceite, negociação, regras comerciais e novos lembretes/etapas.
- 12 testes de interface: pipeline existente, acesso negado, troca de escola, período, filtros e disputa de atribuição.
- Verificação de tipos do frontend e dos três serviços; formatação dos módulos e sintaxe do publicador.
- SQL em base isolada: `sdr_attention_quality.sql`, `sdr_conversation_work.sql`, `sdr_confirmation_timeout.sql`, incluindo reexecução da migration.
- A base de teste contém apenas estrutura e fixtures sintéticas. Funções HTTP foram substituídas por respostas locais antes de qualquer fixture; não houve envio externo de teste. As permissões/ownership necessários às funções antigas foram recompostos na base isolada para testar as mesmas condições do ambiente ativo.
- Conferência visual do painel em computador e em 390 px, sem rolagem horizontal. Fluxo de assumir atendimento conferido com respostas locais simuladas.
- Antes de acrescentar os dois arquivos de CRM, o build da base reproduziu **256/256** hashes JS/CSS/HTML ativos. Isso confirmou que as edições anteriores de atividades, matrícula e Wolfie já pertenciam ao frontend ativo e foram preservadas. Os antigos arquivos estáticos versionados por hash permanecem disponíveis para abas já abertas.

## Limites

A varredura roda a cada cinco minutos, dentro da janela 9h–20h; fora dela, o retorno ocorre na próxima abertura. O prazo de 60 minutos continua valendo para a IA comercial, e o fluxo dirigido de vendedor conserva sua política específica. Sugestões não reservam horário. Preferências em texto livre exigem interpretação: quando não houver opção compatível, a conversa pede uma alternativa, sem afirmar disponibilidade confirmada.

## Publicação

Ativador: `deploy/vps/activate-sdr-quality.py`. O pacote contém 11 arquivos de runtime, uma migration aditiva e o frontend do CRM. Backup antes da ativação; controle de concorrência e comparação de hashes antes/depois. A reversão de runtime preserva a fila e os prazos publicados anteriormente, sem restaurar o banco inteiro sobre novas atividades de clientes.

Estado final: **ACTIVE**, publicado e verificado em 06/09/2026.

- Backup: `/opt/wisewolf/backups/sdr-quality-20260906T173847Z-362cafb371c9`.
- 11/11 arquivos de runtime coincidem com o pacote; o HTML servido coincide com o novo frontend. Site e runtime estão em execução.
- Consulta do painel validada em transação somente leitura com vínculo de gestão do ambiente ativo; permissões públicas negadas. Consulta de disponibilidade executada sem erro no banco ativo.
- Cron de atendimento e cron de retorno continuam ativos, com últimas execuções bem-sucedidas.
- A primeira tentativa (`20260906T173432Z-362cafb371c9`) restaurou o runtime anterior durante a verificação de reinício, sem trocar o frontend. O publicador passou a aguardar a disponibilidade do runtime: a segunda tentativa registrou um HTTP 502 transitório de inicialização, repetiu apenas a verificação sem autorização de envio e concluiu com sucesso. A migration aditiva foi reaplicada de forma idempotente; a fila e os prazos anteriores permaneceram preservados.
- A base `codex_sdr_quality_20260906` foi removida após os testes; a consulta ao catálogo confirmou zero bases com esse nome. Nenhuma mensagem externa foi enviada pelos testes.
