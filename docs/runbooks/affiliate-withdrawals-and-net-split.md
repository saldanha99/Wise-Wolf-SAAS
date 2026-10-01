# Saques de afiliados, comissão e Turbo no rateio

Atualizado em 01/10/2026.

## Solicitação e pagamento do saque

1. O afiliado cadastra seu PIX no painel.
2. Comissões ficam disponíveis após o recebimento efetivo da primeira mensalidade,
   conforme o ledger autorizado. Cartão apenas confirmado ainda não é caixa.
3. “Solicitar saque” reúne todas as comissões CONFIRMED disponíveis e reserva esse
   saldo. A mesma comissão não pode entrar em dois pedidos.
4. Um aviso entra na fila oficial de WhatsApp, para Financeiro; sem grupo próprio,
   usa Direção e depois Gestão. O aviso contém nome, valor, quantidade e data,
   além do caminho na plataforma. A chave PIX fica na ficha do afiliado.
5. A direção abre **Afiliados → ficha → Solicitações de saque**, confere o PIX,
   aprova, realiza o repasse e só depois marca **Pago**. Aprovar não realiza PIX.
   A confirmação de pagamento baixa as comissões vinculadas ao pedido.

Cancelamento e troca de destino são revalidados antes do envio. Uma intenção por
pedido impede duplicatas. Resultado incerto do provedor exige revisão pelas
regras da fila; não disparar outra mensagem manualmente para “corrigir” a fila.
Fixtures são suprimidos. Sem destino configurado, o pedido permanece disponível
na plataforma, mas não há aviso de WhatsApp. Não há backfill de pedidos antigos.

## Quanto entra na base do dízimo

**Base operacional = valor alocado à competência − custo docente previsto −
comissão de afiliado reconhecida nessa matrícula.** Os percentuais só incidem
sobre sobra positiva. Se os custos superarem a receita, o dízimo é zero e o
aviso informa o déficit.

A comissão CONFIRMED ou PAID é custo mesmo antes do saque: pagar o saque não cria
um segundo custo. O vínculo exige aluno, tenant, oferta e afiliado compatíveis;
a primeira mensalidade é identificada pela metadata canônica de ativação ou pela
assinatura/período da oferta. Atribuição retroativa exige vendor e autorização
registrados. Taxa de matrícula e mensalidades seguintes não repetem comissão.
Pagamento completo mantém a reserva mensal e desconta comissão na primeira
alocação, nunca nas parcelas seguintes.

O custo docente segue a agenda atual, os dias da competência, a data de início
da reserva e a tarifa canônica por aluno/data. Portanto é uma **prévia
operacional**, não a margem mensal final. Conferir folha realizada, taxas do
Asaas e demais despesas no DRE antes de tratar a sobra como lucro. Não alterar
comissão, folha ou pagamentos para ajustar essa prévia.

Em 01/10, as duas matrículas retroativas autorizadas tinham comissão de R$ 109
cada. Na competência de setembro, com as aulas previstas após o início da
agenda, Camila tinha R$ 198 − R$ 16 − R$ 109 = R$ 73 (prévia de dízimo R$ 7,30);
André tinha R$ 198 − R$ 24 − R$ 109 = R$ 65 (prévia R$ 6,50). São exemplos do
estado da agenda nessa data, não lucro final garantido.

## Turbo

Usar `teacher_turbo_status_at` para elegibilidade e `teacher_student_rate` para
a tarifa daquele aluno na data da aula. Não aplicar R$ 10,50 a toda a carteira.
A regra vigente na Wise Wolf desde 09/09/2026 é: posições 1–6 a R$ 8/aula e 7+
a R$ 10,50/aula, respeitando piso contratual por aula. A elegibilidade segue
30 dias contínuos sem falta confirmada do professor, carteira mínima e ausência
de contestação aberta. Falta do aluno não reinicia a ofensiva. Trechos históricos
que falam em mês fechado não descrevem a regra atual `rolling_30_days`.

Mateus estava ativo em 01/10, com 11 alunos na carteira. Seu acréscimo de salário
já entrava no rateio; agora o aviso explica o estado Turbo e a tarifa do aluno.

## Verificação e manutenção

Migration reexecutável: `20261001164903_rateio_liquido_afiliados_turbo_e_avisos_de_saque.sql`.
Teste: `supabase/tests/affiliate_net_payment_split.sql`, transacional com rollback,
registrado no release. Cobre comissão única, atribuição retroativa, pagamento da
comissão sem sumir custo, base negativa, reserva do saque, destino/cancelamento,
fixtures e privilégios. Testes Deno cobrem texto individual, fechamento e rota
central. Tour da direção: `2026-10-01-rateio-liquido-e-saques`.

Publicar somente com `deploy/vps/release.sh`, árvore limpa na branch configurada.
Não invocar funções de envio para testar em produção. Consultas não disparam
avisos; mensagens anteriores permanecem como foram enviadas.
