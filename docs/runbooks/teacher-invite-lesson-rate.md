# Valor por aula nos convites de professor

Desde 09/09/2026, novos convites usam o valor integral por aula de 30 minutos. O gerador sugere R$ 8,00 e permite que a escola escolha outro valor. Não multiplicar nem dividir por dois ao criar o convite, cadastrar o professor ou emitir o novo contrato.

Os nomes `hourlyRate` no payload e `profiles.hourly_rate` no banco são mantidos por compatibilidade, mas representam o valor por aula neste fluxo. `register-teacher` exige `rateUnit: PER_LESSON` para evitar a assinatura por uma página antiga em cache e grava essa unidade no snapshot comercial do contrato. A unidade enviada pelo cliente serve somente para detectar a versão; o valor continua sendo lido do convite no servidor.

Para esses novos contratos, `teacher_student_rate` usa o valor combinado como base. As faixas de bonificação existentes podem aumentar esse valor quando aplicáveis, sem reduzi-lo. Substituições explícitas de tarifa em lançamentos continuam seguindo a política existente.

Contratos assinados anteriormente, sem a unidade `PER_LESSON`, mantêm a interpretação histórica na visualização; seus PDFs arquivados e suas regras anteriores de pagamento não são alterados. A correção não converte em massa valores de professores existentes.

Validação: testes do gerador com R$ 8,00 e R$ 12,50; renderização dos contratos novos e antigos; teste transacional `supabase/tests/teacher_per_lesson_rate.sql`, que verifica o valor personalizado e a preservação da regra antiga, revertendo todos os fixtures ao terminar.
