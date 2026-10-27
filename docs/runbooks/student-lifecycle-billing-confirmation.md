# Mudança da matrícula com confirmação financeira

Preparado em 27/10/2026. Publicação da proteção ainda pendente do release oficial.

## Problema e comportamento

O editor da lista de alunos ignorava o erro devolvido por `functions.invoke` e
mantinha um fallback para `set_student_academic_status`. O editor da agenda usava
diretamente essa RPC. Ela alterava status/lifecycle sem conferir ou interromper a
recorrência no provedor. Assim, um cadastro inativo podia continuar com assinatura
Asaas ativa, especialmente quando o vínculo local de assinatura estava ausente.

Os dois editores, a ação de pausa/reativação e o encerramento usam agora
`changeStudentLifecycle`, que exige `ok: true` do `school-admin`. Erros de
transporte, conflito de negócio e resposta incompleta interrompem o fluxo antes
de anunciar sucesso. Não há fallback de escrita nem repetição automática de uma
operação cujo resultado é incerto.

A RPC antiga mantém assinatura, autorização e resposta compatíveis somente para
pedido idempotente do status já vigente. Mudar status/lifecycle por ela, inclusive
indiretamente pelo editor pedagógico, exige o fluxo financeiro e retorna
`student_lifecycle_requires_school_admin`. Professores e coordenadores continuam
sem permissão de administrar o ciclo da matrícula. Edição pedagógica permanece
disponível dentro das permissões existentes.

`school-admin` continua responsável por inventário Asaas, guardas de identidade,
claim durável, política financeira, agenda e finalização. Esta alteração não
reduz essas guardas, não transforma dívida antiga em estorno e não renova contrato
de aluno encerrado. Criação de cobrança continua limitada a aluno ativo.

## Operação e histórico legado

Para uma matrícula inativa com cobrança no provedor, conferir também as
assinaturas do cliente por GET: o campo local `subscription_id` pode estar vazio.
Cancelar só uma fatura não interrompe a recorrência. Não adivinhar o aluno de um
cliente órfão nem criar vínculo falso para conseguir cancelar; decisões exatas da
direção e reparos operacionais devem ter backup, prova fresca e auditoria própria.

Preservar todos os recebimentos e documentos assinados, registrando a data real do
crédito. Dívida histórica e multa rescisória exigem decisão própria; a ausência de
novas mensalidades não equivale à renúncia desses créditos. Se o provedor já
excluiu uma fatura antiga, conciliar o estado local por prova, sem outro DELETE.

## Verificação

- `lib/studentLifecycleRequest.test.ts`: confirmação, falha HTTP com corpo útil,
  rejeição de respostas não confirmadas, ausência de fallback e de retry incerto.
- `supabase/tests/student_status_and_level_management.sql`: RPC direta e chamada
  pedagógica não suspendem/reativam; falha composta atômica; pedido vigente
  idempotente e permissões pedagógicas preservadas. Migration aplicada duas vezes
  seguida dessa suíte em transação com rollback na VPS.
- Typecheck da aplicação, 33 Vitest relacionados e 17 Deno de autorização,
  criação e prova de encerramento aprovados antes da publicação.
- Migration `20261027114059_student_lifecycle_requires_financial_confirmation.sql`
  registrada no release. Tour `2026-10-27-matricula-e-cobranca-juntas` para direção.

Publicar somente pelo `deploy/vps/release.sh`, com árvore limpa na branch
configurada, e conferir a função efetiva e os bundles HTTP depois da ativação.
