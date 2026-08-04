-- Remove a faixa de R$ 9,50 (5º ao 9º aluno).
--
-- A escola só opera com a trava de 10+ alunos para a progressiva, então a faixa
-- intermediária nunca podia ser alcançada: quem tem menos de 10 fica no base, e
-- quem tem 10+ já vale R$ 10,50 do 10º em diante. Manter a linha só confundia o
-- contrato e o cálculo.
--
-- Efeito em teacher_student_rate: aluno na posição 5 a 9 passa a cair na faixa
-- min_students=1 (R$ 8,00) em vez de 9,50. Confirmado com a direção em 02/08/2026.
DELETE FROM teacher_pay_tiers WHERE min_students = 5;
