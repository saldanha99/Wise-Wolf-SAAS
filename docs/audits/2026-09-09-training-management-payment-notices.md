# Treinamentos, participantes da gestão e avisos de pagamentos — 09/09/2026

Publicado na instalação Wise Wolf. O pedido permite que todos os participantes humanos do grupo de gestão configurado preparem e confirmem as ações do assistente, mesmo sem perfil na plataforma. O envio recebido continua autenticado e vinculado à instância/escola; mensagens de outros grupos não entram no fluxo. Cada confirmação exige o mesmo participante e o código da ação. Identificadores LID do WhatsApp são aceitos. Não foram atribuídos perfis administrativos artificiais aos participantes.

A opção `allow_group_member_actions` foi ativada somente para `school-wise-wolf`. As funções financeiras e acadêmicas mantêm os limites, os controles de escola e a execução idempotente. Participantes sem perfil só passam pelas variantes de serviço quando a ação confirmada, os parâmetros, o grupo e o solicitante correspondem ao registro pendente. Solicitações e resultados ficam em `gestao_action_audit`.

## Treinamento dirigido

- Lançador → Treinamento de professor: seleção de treinador habilitado e teacher já cadastrado, data e horário de Brasília, duração de 30 minutos.
- A mesma operação pode ser preparada por texto ou áudio no grupo, por exemplo: “Matheus vai treinar a teacher Maria amanhã às 16h30”. Nomes ambíguos ou informações ausentes pedem esclarecimento; “Matheus” também resolve “Mateus” somente quando a busca normal não encontra cadastro e a alternativa é única.
- Após a confirmação com o código no grupo, o convite entra na fila do WhatsApp do teacher. Abrir ou pré-visualizar o link não aceita nada: o aceite usa POST e token aleatório de 256 bits, armazenado como hash em esquema privado.
- O aceite revalida os dois teachers e a agenda. O agendamento fica disponível ao treinador no lançador de aulas. Um treinamento confirmado bloqueia compromissos simultâneos de ambos.
- R$ 16 são fixados para o treinador e só entram no fechamento após a conclusão registrada, uma única vez. O novo fluxo não cria remuneração para o participante treinado nem modifica oportunidades antigas de treinamento.
- Cancelamento pela gestão libera o horário e impede lançamento posterior; treinamentos já lançados não podem ser cancelados por essa operação.
- O proprietário esclareceu que Mateus manda o link da sala na hora. A sala é opcional; o sistema envia o link de aceite. Se houver uma sala válida cadastrada, ela aparece após o aceite.
- Os testes não criaram treinamentos ou convites reais.

## Recuperação autorizada de quatro avisos

O proprietário autorizou explicitamente corrigir os vínculos e enviar os quatro avisos, excluindo Mariana e Gianini de qualquer reenvio.

| Aluno | Pagador mencionado | Valor | Pagamento real | Resultado |
|---|---|---:|---|---|
| Nicolas de Sousa Costa | Sandra | R$ 229 | 08/09/2026 | RECEIVED; um aviso, uma tentativa |
| Ana Clara Sant’Ana | Camila Gaburro Santana | R$ 261 | 08/09/2026 | RECEIVED; um aviso, uma tentativa |
| Verônica Florêncio Ferraz Torres Duarte | — | R$ 229 | 09/09/2026 | RECEIVED; um aviso, uma tentativa |
| Maxuel Bonfim Franceschi Silva | — | R$ 187 | 09/09/2026 | RECEIVED; um aviso, uma tentativa |

Nicolas, Verônica e Maxuel tinham cobranças locais, mas o perfil não continha a assinatura vinculada. Ana Clara ainda apontava para uma assinatura expirada, enquanto Camila pagou a assinatura sucessora ativa, que também não tinha referência interna do aluno.

Antes da correção, consultas atuais ao Asaas verificaram cobrança recebida, valor, cliente, assinatura e unicidade da assinatura ativa. A correção atualizou as quatro referências locais; em Ana Clara, também preencheu a referência interna da assinatura ativa no Asaas, preservando valor, periodicidade, vencimento e situação. Somente os quatro eventos originais PAYMENT_RECEIVED foram recolocados na fila. A rotina normal registrou os recebimentos e criou os avisos, preservando as datas reais.

O histórico do provedor foi consultado pelo identificador de cada mensagem e pelo grupo exato: os quatro avisos existem no destino correto. O provedor aceitou cada envio com HTTP 201. Não retornou comprovantes de leitura/entrega ao dispositivo; por isso a conferência não falsificou esses estados nem marcou mensagens como lidas. Os registros permanecem aguardando os respectivos recibos no controle de envio. Mariana e Gianini não foram reenviadas.

Para evitar recorrência em assinaturas antigas, um pagamento recebido sem referência interna agora pode ser reconhecido quando já existe vínculo local exato de assinatura e cliente e um GET atual do pagamento e da assinatura confirma identidade, valor, vencimento e data de recebimento. Referências não vazias desconhecidas, assinaturas diferentes, valores divergentes, pagamentos não liquidados e vínculos ambíguos continuam bloqueados. A função de banco revalida escola, matrícula ativa, assinatura, cliente e idempotência.

## Validação

- 11 testes Vitest: acesso do grupo, identidade LID/telefone, confirmação do solicitante, formulário, data de Brasília, repetição idempotente, página do convite e origem de pagamentos legados.
- 23 testes Deno existentes de eventos financeiros e conclusão de matrícula passaram. A primeira execução sem permissão de leitura foi repetida com a permissão necessária aos testes que leem arquivos.
- Verificação de tipos do frontend e das funções alteradas passou.
- Testes transacionais no PostgreSQL: participante sem perfil executando a ação exata; negativa para outra escola/valor/solicitante; agendamento sem sala; aceite; conflito na agenda do participante; impedimento de pagamento antecipado; R$ 16 após conclusão; ausência de duplicação; reconhecimento de recebimento legado sem duplicação. Todas as transações de teste foram revertidas e as identidades/cobranças de teste foram verificadas como ausentes.
- Navegador: tela do lançador com dados simulados; módulo publicado importado com sucesso na plataforma; página pública de convite rejeita token inválido.
- O fluxo completo de WhatsApp com um treinamento real ainda depende de um agendamento solicitado pela gestão; não foi disparado um convite real apenas para testar.

## Publicações e cópias de segurança

Publicações restritas às funções e ao módulo do lançador alterados; outras alterações locais não foram publicadas. O cache do módulo foi atualizado.

- `/opt/wisewolf/releases/training-group-20260909`
- `/opt/wisewolf/backups/training-group-20260909`
- `/opt/wisewolf/releases/payment-origin-training-room-20260909`
- `/opt/wisewolf/backups/payment-origin-training-room-20260909`
- `/opt/wisewolf/backups/payment-notices-20260909`: evidências do Asaas e estado anterior dos quatro registros; diretório restrito, sem credenciais nas saídas.

Não repetir os scripts de recuperação após sucesso: os quatro eventos já foram processados e os avisos submetidos.
