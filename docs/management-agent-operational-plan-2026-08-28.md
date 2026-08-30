# Gestor da escola no WhatsApp — plano operacional seguro

Data: 28/08/2026

## Decisão

O grupo de gestão pode se tornar a principal interface operacional da escola,
por texto ou áudio. Ele não deve, porém, ser uma versão textual da tela com
acesso irrestrito ao banco. A arquitetura correta é um catálogo fechado de
ferramentas: o modelo entende o pedido e preenche os dados; código determinístico
valida identidade, permissão, estado atual e conflitos; uma função transacional
executa; a trilha de auditoria registra o resultado.

“Tudo o que existe no sistema” é a direção do produto, não uma única liberação.
Cada ação entra no catálogo somente depois de ter contrato, executor canônico,
idempotência, política de risco e teste.

## Fluxo obrigatório de uma ação

1. Autorizar o grupo e identificar o participante pelo telefone vinculado ao
   perfil e à membership ativa da escola.
2. Transcrever áudio somente depois da autorização.
3. Classificar a intenção em uma ferramenta existente; texto do usuário nunca
   cria nome de tabela, consulta ou ferramenta nova.
4. Resolver nomes para IDs sem escolher quando houver ambiguidade.
5. Fazer uma prévia legível, incluindo o efeito real da ação.
6. Exigir confirmação vinculada à mesma pessoa e a um código curto, com validade
   de cinco minutos.
7. Fazer claim atômico, revalidar permissões e executar uma única vez.
8. Auditar pedido, confirmação, resultado e ator. Segredos e tokens não entram
   no log nem voltam ao grupo.

## Catálogo e risco

| Domínio | Ferramenta | Risco | Confirmação | Situação |
|---|---|---:|---|---|
| Financeiro | Registrar conta/despesa | Crítico | Mesmo diretor + código | Base implementada |
| Financeiro | Ajustar repasse de professor | Crítico | Mesmo diretor + código | Base implementada |
| Pedagógico | Pedir cobertura pontual | Alto | Mesmo gestor + aceite do substituto | Implementado |
| Pedagógico | Transferir aluno de professor de forma recorrente | Crítico | Mesmo gestor + código + aceite | Base implementada |
| Pedagógico | Alterar horário recorrente do aluno | Alto | Mesmo gestor + código | Base implementada |
| Consulta | Agenda, faltas, inadimplência, DRE e pendências | Leitura | Sem confirmação | Parcial; ampliar por visões seguras |
| Relacionamento | Criar tarefa/observação interna | Médio | Prévia simples | Próxima fase |
| Comunicação | Enviar mensagem para aluno/professor | Alto | Prévia exata do destinatário e texto | Próxima fase, via outbox |
| Contrato | Pausar, cancelar, renovar ou trocar plano | Crítico | Confirmação reforçada; alguns casos exigem humano | Fase posterior |
| Pagamento | Pagar conta, estornar, cobrar ou alterar assinatura | Crítico | Nunca apenas com “sim” no grupo; step-up e política financeira | Fase posterior |

“Conta a pagar” hoje grava uma saída futura ou recorrente. Antes de anunciar um
workflow completo de contas a pagar, o domínio precisa representar explicitamente
os estados `ABERTA`, `PAGA`, `CANCELADA` e a conciliação correspondente.

## Cobertura pontual não é transferência recorrente

Quando um professor falta, a agenda fixa do aluno permanece com o titular. O
gestor indica a ocorrência e um substituto; o sistema valida a aula e a
disponibilidade, cria o convite e espera o aceite. Somente o aceite confirmado
redireciona a aula e sua contabilização para quem a ministrará.

Uma troca recorrente de professor é outra ferramenta, com outro efeito e outro
nível de risco. Os nomes e contratos permanecem separados no catálogo para que
o modelo não transforme doença de um dia em mudança permanente de carteira.

## Estrutura dos agentes

- **Supervisor:** identifica domínio, risco e próximo agente. Regra e identidade
  são determinísticas; o modelo não aumenta privilégio.
- **Especialistas:** financeiro, pedagógico, comercial, RH e secretaria. Cada um
  recebe apenas as ferramentas e os dados mínimos do seu domínio.
- **Executor de ferramentas:** valida schema, tenant, ator, limites e estado,
  executando por RPC transacional ou serviço canônico.
- **Portão de saída:** controla mensagens externas, dados pessoais e escalada
  humana.
- **Auditoria e observabilidade:** registra latência, modelo, versão do contrato,
  ferramenta, decisão, resultado e motivo de fallback.

O modelo é útil para entender linguagem, resolver a conversa e explicar. Ele não
deve calcular totais financeiros, escolher silenciosamente entre homônimos,
montar SQL ou decidir autorização.

## Ordem recomendada de ampliação

1. Consolidar as cinco ferramentas atuais e publicar em modo controlado.
2. Criar consultas seguras de agenda, alunos, professores, financeiro e
   pendências, sem enviar o snapshot inteiro a todo especialista.
3. Adicionar tarefas internas e observações, com baixo dano e boa reversibilidade.
4. Colocar toda comunicação externa em outbox com supressão, deduplicação e
   acompanhamento de entrega.
5. Adicionar contratos e cobranças apenas após step-up de autenticação, limites,
   reconciliação e política de aprovação.
6. Evoluir de convite nominal de cobertura para oportunidade oferecida a vários
   professores, com claim atômico “primeiro aceite válido vence”.

## Portões antes de ampliar além do piloto

- Tornar a auditoria parte transacional da ação. Hoje a trilha existe, mas uma
  indisponibilidade isolada do armazenamento de auditoria não desfaz uma ação
  que já foi concluída.
- Colocar entrada e saída do WhatsApp em inbox/outbox duráveis, com chave
  idempotente no provedor e reconciliação. Isso fecha a pequena janela entre o
  envio aceito pelo provedor e a gravação local de `dispatched_at`.
- Aplicar orçamento de tempo por especialista e validação factual dos relatórios
  do time de IA; o portão atual melhora formato e completude, mas ainda não
  comprova cada afirmação contra uma fonte canônica.
- Levar a materialização de sobras entre meses para a mesma transação do
  fechamento. Hoje fechamentos simultâneos de meses diferentes falham com
  segurança, mas um deles pode precisar de nova tentativa.
- Só depois desses portões abrir comunicação externa, contratos, cobranças ou
  o catálogo inteiro para todos os tenants.

## Critérios para liberar uma ferramenta

- permissão testada por papel e tenant;
- IDs e relações revalidados no executor, nunca confiados ao modelo;
- operação idempotente e protegida contra concorrência;
- confirmação proporcional ao risco;
- rollback ou compensação definidos;
- auditoria sem segredos;
- resposta honesta para sucesso, falha e sucesso parcial;
- teste unitário e teste SQL de autorização/concorrência;
- execução em `shadow` ou tenant piloto antes de ampliar.

O indicador principal não é “quantos pedidos a IA respondeu”. É a proporção de
ações concluídas corretamente, sem correção manual, sem duplicidade e sem cruzar
tenant ou papel. Ambiguidades recusadas com clareza contam como acerto.
