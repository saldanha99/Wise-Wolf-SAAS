# Atendimento comercial: duplicação e confirmação do professor

## Resultado

Correções publicadas em 05/09/2026, após autorização do proprietário para concluir e melhorar os fluxos. Release: `20260905T191359Z-d5a6c767b69b`.

Serviços atualizados: `whatsapp-inbound`, `funnel-sweeper` e `sdr-followups`, com módulos compartilhados e duas migrations. As alterações locais anteriores de feriados, telefone verificado e orientação financeira foram comparadas com a versão ativa e preservadas. Componentes e conteúdos pedagógicos em edição não entraram nesta publicação.

Backup validado do banco e dos arquivos anteriores: `/opt/wisewolf/backups/sdr-20260905T191359Z-d5a6c767b69b`. O pacote aplicado, os hashes de origem/destino e o ativador estão em `/opt/wisewolf/releases/20260905T191359Z-d5a6c767b69b`. A publicação usa o mesmo bloqueio de deploy, registro transacional e marcadores de migrations da release principal. O manifesto de funções foi atualizado somente para os três serviços revisados.

## Causas confirmadas

Na conversa indicada pelo proprietário, em 04/09, horário de Brasília:

- Às 14h45, a atendente abriu uma remarcação com a Teacher Laís para 18h30.
- Às 20h24, o cliente escreveu “Estou aguardando”. A atendente repetiu a promessa para 18h30. O banco registrou `requested_time_not_future`, mas a resposta de sucesso era montada independentemente do resultado.
- A solicitação permanecia `PENDING`, apesar do vencimento. Não havia retorno automático específico para remarcações sem resposta do professor.
- Duas mensagens próximas do cliente também geraram duas respostas sobre o nível de inglês. A proteção por identificador de webhook não impedia execuções simultâneas para mensagens diferentes do mesmo contato.

O prazo de 60 minutos alertava a direção. A expiração de experimentais genéricas podia esperar 48 horas; o retorno ao aluno dependia dessa expiração.

## Comportamento publicado

### Uma resposta por vez na mesma conversa

A entrada comercial é registrada antes da execução e usa uma fila persistente por escola e telefone. Uma pequena janela de dois segundos reúne a sequência de mensagens no histórico. Só uma execução obtém autorização para responder àquela conversa.

Se chegar outra mensagem durante a geração, a resposta antiga perde a autorização para executar ações; a próxima execução usa o histórico completo. Mensagens que chegam durante um envio ficam pendentes para a sequência. A recuperação roda a cada minuto.

Uma execução interrompida durante a geração pode ser recuperada. Depois que ações externas começaram, uma interrupção incerta não repete o atendimento inteiro: o estado vai para revisão e o lead fica em atendimento humano. Há limite de três tentativas de geração. Uma nova mensagem pode retomar o contato depois que o atendimento humano deixa de estar ativo, sem repetir a execução antiga.

Os retornos por prazo vencido e os follow-ups usam o mesmo controle da conversa; uma mensagem pendente do cliente tem prioridade sobre um lembrete.

### Estado de agendamento e prazo

- “Fico no aguardo”, agradecimentos e reconhecimentos simples consultam a solicitação existente. Não criam outro convite nem reiniciam o prazo.
- Pedido genérico repetido não dispara novamente aos professores.
- Repetição de texto, com variações apenas de pontuação/formatação, é suprimida quando não há mudança de estado.
- Horário passado é recusado antes da solicitação. Falha real ao solicitar remarcação é explicada ao cliente e encaminhada à coordenação.
- Remarcação vence em 60 minutos no banco. O horário original da aula fica preservado. Aceite atrasado não revive a solicitação.
- Experimentais genéricas sem professor também expiram após 60 minutos e abrem negociação de outra opção.
- Retentativas de aviso usam uma reserva por solicitação/rodada, válida entre dias. Envio com resultado ambíguo mantém a reserva; só rejeição conhecida permite nova tentativa automática.
- A varredura percorre todas as páginas recentes para não ficar presa aos primeiros registros já tratados.

### Qualidade da conversa

O prompt comercial aproveita nome, objetivo, nível e histórico já conhecidos, evita recomeçar a apresentação e pede no máximo duas alternativas por vez. A geração comercial usa temperatura menor. O menu considera professores ativos e com telefone para convite. O horário anterior de uma experimental não é descrito como compromisso futuro quando já passou.

Os follow-ups deixam de perguntar se o aluno ainda tem interesse enquanto há pedido de remarcação, aula experimental ativa ou mensagem em processamento. As proteções de contrato, atendimento humano, feriados e roteamento da escola continuam valendo.

## Verificação

- 85 testes Deno aprovados: conversa, fila, remarcação, histórico, transporte, política comercial, feriados e orientação financeira.
- Verificação de tipos dos três serviços: aprovada.
- Suítes SQL `sdr_confirmation_timeout.sql`, `sdr_conversation_work.sql` e a suíte existente de remarcação: aprovadas.
- Limite exato de 60 minutos, repetição sem prorrogação, aceite tardio, aceite válido, preservação de agenda e isolamento de escola verificados no banco.
- Seis conexões simultâneas disputaram a mesma conversa: exatamente uma obteve a execução.
- Testes de prioridade de entrada sobre lembrete, entrada durante envio e recuperação com token antigo bloqueado: aprovados.
- Migrations reaplicadas na base isolada para verificar reexecução.
- Os testes usaram cópia somente da estrutura, sem dados de clientes, e funções HTTP substituídas por respostas locais. Nenhum teste enviou WhatsApp externo. A base temporária foi removida ao final.
- Sintaxe do ativador, sintaxe da release e diff dos arquivos alterados: verificados.

### Validação no ambiente ativo

Após a publicação:

- Os quatro testes de acesso não autorizado retornaram a proteção esperada, confirmando carregamento dos serviços.
- O worker autenticado respondeu HTTP 200, `ok=true`, com zero entradas pendentes naquele momento.
- Cron de retorno: a cada cinco minutos; cron de recuperação: a cada minuto. Ambos tiveram execução bem-sucedida.
- A primeira execução real do `funnel-sweeper` respondeu HTTP 200, `ok=true` e zero falhas.
- Zero remarcações vencidas ainda em `PENDING`; zero pedidos pendentes com prazo superior a 60 minutos.
- Nenhum novo erro de carregamento, de fila ou de autorização de envio foi encontrado na verificação dos logs.
- Zero textos comerciais entregues em duplicidade na pequena janela observada após a publicação. Isso é uma verificação inicial, não uma garantia estatística de ausência de duplicações futuras.

## Limites operacionais

O retorno ocorre na primeira varredura após 60 minutos, normalmente entre 60 e 65 minutos, dentro da janela de atendimento de 9h às 20h. Fora dessa janela, o retorno fica para a próxima abertura. A indisponibilidade do WhatsApp e o atendimento humano podem adiar ou suprimir o contato.

O teto diário de 15 retornos foi substituído por lote de 15 por varredura para as experimentais genéricas: o limite diário não abandona mais clientes aguardando resposta. A prospecção fria mantém seus limites existentes. Os candidatos a retorno são lidos em uma janela de três dias; não houve disparo manual para conversas históricas.

Pedidos dirigidos do fluxo específico de vendedor mantêm a política própria; não são o fluxo da atendente de anúncios revisado aqui. Alterações de agenda continuam exigindo confirmação do professor. Não houve remarcação manual de cliente nesta tarefa.

O provedor de WhatsApp pode ter falhas ambíguas. A política publicada evita reenvio automático nesse caso e registra o resultado para análise. Não há promessa de entrega externa exatamente uma vez em qualquer cenário de falha.
