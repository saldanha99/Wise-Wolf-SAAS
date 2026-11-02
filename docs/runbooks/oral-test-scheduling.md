# Agendamento de teste oral

O painel Testes Orais continua sendo a fonte do checkpoint. Para examinador TEACHER,
`schedule_oral_test` reserva um appointment `oral_test` de 30 minutos, vinculado por
`oral_tests.appointment_id`. O aluno não troca de professor titular. A reserva é
um evento de data específica, apresentado no Explorador, na Agenda do professor,
em Aulas de Hoje e na Agenda do aluno. A opção Diretoria sem professor nomeado
continua sem reserva individual e sem avisos individuais; o modal explicita isso.

O servidor recusa passado, horário fora da grade de 30 minutos, examinador inativo,
sem aptidão, professor titular/segundo do aluno e conflitos com aulas, reposições,
experimentais, treinamentos, antecipações, coberturas e reservas pós-experimental.
Os escritores de bookings/appointments/reschedules/class_coverages/lesson_advances
respeitam a reserva oral e compartilham a trava de slot.

Cada versão de agendamento prepara ORAL_TEST_STUDENT e ORAL_TEST_TEACHER e dois
ORAL_TEST_REMINDER_* para 30 minutos antes. Todos usam a instância central, a fila
oficial, seus tetos e recibos. O painel mostra o estado real dos avisos; aceitar no
provedor não equivale a entregar. Fixture ou contato ausente não gera mensagem.
O worker e a cerca revalidam horário, examinador, aluno ativo, contato, versão,
reserva e texto antes de enviar. O link, quando existente, é o mesmo appointment
para os dois; sem ele, o texto informa que será combinado com a escola. O fluxo
não cria uma sala oficial do Meet para o teste.

Repetir exatamente a chamada não muda versão nem reenvia. Reagendar move a mesma
reserva, invalida avisos pendentes antigos e prepara os novos. Desmarcar retorna
a DUE e libera a reserva; concluir ou apagar também encerra a reserva e cancela
pendências. A direção deve comunicar o cancelamento aos participantes: desmarcar
não dispara mensagem de cancelamento. Mensagem já aceita/entregue permanece na
trilha; resultado incerto continua sob a política existente, sem replay no chute.

Nenhum class_log, presença ou pagamento nasce do agendamento ou da conclusão do
checkpoint. A régua financeira e o lançamento de aulas não foram alterados.

Migration: `20261002193942_oral_test_scheduling_lifecycle`. Teste SQL transacional:
`supabase/tests/oral_test_scheduling_lifecycle.sql`. Ambos registrados no release.
