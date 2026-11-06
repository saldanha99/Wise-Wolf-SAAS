# Atribuição temporária de aulas

Outro professor assume reposições de um aluno por um período. A grade fixa e o
professor titular não mudam. Use quando um professor deixou aulas pendentes ou quando
é preciso redistribuir reposições por um tempo.

Não é a ferramenta certa para trocar o professor do aluno de vez (use a transferência)
nem para uma única aula de outro professor (use a cobertura).

## Como usar

Cobertura e Reposições → Atribuição temporária, ou a agenda na ficha do aluno.

1. Escolha o aluno, o professor original e quem assume. Professor suspenso ou que saiu
   pode ser a origem, nunca quem assume.
2. Defina os dias, os horários e o período. Horários de meia em meia hora, até 4 horas.
3. Informe o total de aulas pendentes, em aulas de 30 minutos. Em branco, o sistema
   sugere o saldo já conhecido ou as reposições abertas.
4. Clique em Ver as aulas. A lista mostra aula por aula o que entra na agenda e por que
   alguma ficou de fora. Mudar qualquer campo exige ver de novo.
5. Escreva o motivo e gere as aulas. O motivo só é visto pela direção e pela coordenação.

Exemplo: 1 hora aos sábados, de 07/11 a 31/12/2026, saldo de 22. São 8 sábados × 2 aulas
de 30 min = 16 aulas na agenda, e 6 ficam sem professor até a próxima atribuição.

## O que o sistema faz

- **Aulas:** cada aula de 30 min é uma linha de `reschedules` com data, ligada à
  atribuição por `temporary_assignment_id`. Agenda, Lançar Aula, Pendentes, confirmação
  de presença, sala oficial, lembrete, Links e histórico leem como qualquer reposição.
- **Grade e titular:** `bookings` e `profiles.professor_id` não são tocados. O aluno não
  entra na carteira de quem assumiu, então não conta para o Turbo.
- **Pagamento:** a aula nasce `fault_type = 'TEACHER'` com atestado de quem criou. Lançada,
  vira `REPOSIÇÃO_PROF` e entra na folha pelo valor normal de quem deu a aula. Falta de quem
  assumiu não paga e a aula continua no saldo.
- **Choque:** por data concreta. Professor: aula fixa vigente, reposição, agendamento,
  treinamento, cobertura, antecipação e horário reservado. Aluno: aula fixa, reposição e
  antecipação com qualquer professor. Feriado nacional fica fora do plano. Grade declarada
  só avisa.
- **Saldo:** por par aluno + professor original. Vale o total da atribuição mais recente.
  `pendentes` = total − realizadas − faltas do aluno. `sem_professor` = pendentes − aulas na
  agenda. A geração nunca passa do saldo.
- **Créditos antigos:** reposições sem data no nome do professor original são substituídas
  pelas aulas geradas (`replaced_by_assignment_id`), para não contar em dobro. Se a aula
  gerada for cancelada, o crédito volta a ficar aberto.
- **Avisos:** uma mensagem para quem assumiu, uma para a família e uma para o canal de
  coordenação, pela fila oficial. As aulas são geradas com `app.reschedule_silent`, senão
  sairiam grupo e família por aula. A desmarcação ou remarcação de uma aula avulsa pela tela
  de Reposições segue avisando como sempre.
- **Termo individual:** vale a regra da reposição por substituto. Aluno atual, com titular
  coberto, e substituto com contrato geral aceito não exigem termo. Fora disso, a prévia
  avisa e a criação é recusada até o termo ser assinado.

## Encerramento

- **Manual:** Encerrar, com motivo. Só a direção e a coordenação da escola.
- **Automático:** cron `wisewolf-temporary-assignments-end`, às 06:20 de Brasília, quando
  não há mais aula por vir. Avisa só a coordenação.

As aulas futuras são fechadas com `used_at`, `closed_reason` e `date = 'Pendente'`. A data
antiga fica em `reschedule_events.from_date`. Aula que já passou e não foi lançada continua
aberta para o professor lançar.

⚠️ Não mantenha a data ao fechar. `upcoming_classes` e o Lançar Aula não olham `used_at`, de
propósito, e o aluno receberia o link de confirmação de uma aula cancelada.

## Consultas

```sql
-- Atribuições ativas e o que falta
select a.id, s.full_name, t.full_name as assume, a.starts_on, a.ends_on, a.lessons_owed,
       private.temporary_assignment_counts(array[a.id]) as aulas,
       private.temporary_assignment_pool(a.tenant_id, a.student_id, a.original_teacher_id) as saldo
  from public.temporary_lesson_assignments a
  join public.profiles s on s.id = a.student_id
  join public.profiles t on t.id = a.temporary_teacher_id
 where a.status = 'ACTIVE';
```

## Limites conhecidos

- Editar dias ou horários de uma atribuição: encerre e crie outra. Uma aula avulsa se remarca
  pela tela de Reposições.
- Aluno ou professor que deixa de estar ativo não encerra a atribuição sozinho, porque pode
  ser uma pausa. O painel avisa e a direção decide.
- Quem assume não precisa aceitar: é avisado. Quando o professor precisa aceitar, use a cobertura.

Testes: `supabase/tests/atribuicao_temporaria_de_aulas.sql`,
`components/TemporaryAssignmentsPanel.test.tsx`, `lib/temporaryAssignments.test.ts`.
