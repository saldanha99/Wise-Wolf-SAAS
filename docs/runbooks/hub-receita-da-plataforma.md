# Hub — receita da plataforma (separada da escola)

**Decisão do dono em 03/11/2026 (opção A):** o dinheiro das assinaturas do Wise
Wolf Hub (e do Wolfie avulso) entra na **mesma conta Asaas da escola**, mas
**não** é receita da escola. Fica fora do caixa, do DRE, do rateio, do
fechamento e da conciliação financeira da escola. A receita do Hub é apurada por
uma **consulta mensal** de leitura, documentada aqui. Não existe código de caixa
nem conta de DRE para ela — de propósito.

Este documento é para o dono e para o contador. As opções B e C, no fim, são
alternativas para quando a separação por consulta deixar de bastar.

## 1. Por onde o dinheiro do Hub passa (e por onde não passa)

| Peça | Hub | Escola |
|---|---|---|
| Cobrança no Asaas | `externalReference = hub:<id do checkout>` | `externalReference` do aluno / matrícula |
| Livro local | `hub_subscription_payments` (`APPLIED` / `REVERSED` / `OVERDUE`) | `student_payments` |
| Caixa (`financial_transactions`, `get_cashflow`) | **não entra** | entra pelo gatilho `trg_ledger_on_payment` |
| DRE (`dre_gerencial`) | **não entra** | 3.1.01 Mensalidades, 3.1.02 Matrículas… |
| Rateio (`trg_notify_payment_split`) e indicação (`trg_grant_referral_reward`) | **não disparam** | disparam a partir de `student_payments` |
| Conciliação Asaas (`asaas-reconcile`) | só confere integridade (`PRODUCT_PAYMENT_*`) | confere e concilia o caixa |

O roteamento é feito no `asaas-webhook` (`dispatchPersistedAsaasEvent`): evento
com referência `hub:` (ou de assinatura ligada a um `hub_checkout_sessions`) vai
para `processHubPaymentEvent` **antes** de `processarPagamento`, que é quem grava
em `student_payments`. A conciliação diária reconhece `hub:` como produto
(`productFamilyFromReference` em `asaas-reconcile/diff.ts`) e acusa
`PRODUCT_PAYMENT_MISSING_LOCAL` se o Asaas tiver uma cobrança `hub:` que o livro
do Hub não tem — mas não soma esse valor em lugar nenhum da escola.

## 2. Consulta mensal

Soma, por família de produto e por mês de Brasília, os pagamentos aplicados
(`applied_at`) menos os estornados (`reversed_at`). É só leitura.

```bash
ssh wisewolf-vps "docker exec -i supabase-db psql -U postgres -d postgres -At -F '|' -v ON_ERROR_STOP=1" <<'SQL'
set default_transaction_read_only = on;
with pagamentos as (
  select
    p.product_family as familia,
    p.status,
    c.amount as valor,
    p.applied_at,
    p.reversed_at
  from public.hub_subscription_payments as p
  join public.hub_checkout_sessions as c on c.id = p.checkout_id
  where p.provider = 'ASAAS'
    and p.applied_at is not null
    and coalesce(c.metadata ->> 'test_fixture', 'false') <> 'true'
),
movimentos as (
  select familia,
         date_trunc('month', applied_at at time zone 'America/Sao_Paulo')::date
           as mes,
         valor as recebido, 0::numeric as estornado,
         1 as pagamentos, 0 as estornos
  from pagamentos
  union all
  select familia,
         date_trunc('month', reversed_at at time zone 'America/Sao_Paulo')::date,
         0, valor, 0, 1
  from pagamentos
  where status = 'REVERSED' and reversed_at is not null
)
select to_char(mes, 'YYYY-MM') as mes, familia,
       sum(pagamentos) as pagamentos, sum(recebido) as recebido,
       sum(estornos) as estornos, sum(estornado) as estornado,
       sum(recebido) - sum(estornado) as liquido
from movimentos
group by mes, familia
order by mes, familia;
SQL
```

Executada em 03/11/2026: rodou sem erro e **não devolveu linha** — o Hub ainda
não teve nenhum pagamento (as tabelas `hub_checkout_sessions` e
`hub_subscription_payments` estão vazias).

**Como ler:**
- `familia`: `HUB_CORE` (planos do professor e institucional) ou
  `WOLFIE_STANDALONE` (Wolfie avulso para aluno). As duas usam a referência
  `hub:` no Asaas.
- `recebido`: valor **bruto** cobrado (o `amount` do checkout; renovações da
  mesma assinatura usam o mesmo checkout e o mesmo valor). A tarifa do Asaas
  **não** está descontada — o líquido real está no extrato do Asaas.
- `estornado`: entra no mês em que o estorno aconteceu, não no mês do
  pagamento. Um pagamento de outubro estornado em novembro aparece como
  `recebido` em outubro e `estornado` em novembro.
- Pagamento que caiu **depois** de um cancelamento não é aplicado (o checkout
  ganha `postCancellationPaymentObservedAt` e `requiresManualReconciliation`) e
  **não** aparece aqui: ele precisa ser estornado ou tratado à mão, e é preciso
  olhar o Asaas para vê-lo.
- Contas de teste (`metadata.test_fixture = true` no checkout) ficam de fora.

**Para achar os casos que a soma não cobre:**

```sql
select c.id, c.status, c.amount, c.updated_at
from public.hub_checkout_sessions as c
where coalesce(c.metadata ->> 'requiresManualReconciliation', 'false') = 'true'
   or coalesce(c.metadata ->> 'reconciliation_required', 'false') = 'true'
order by c.updated_at desc;
```

## 3. Como reconhecer no extrato do Asaas

- **Referência externa** `hub:<uuid>` — o uuid é o `id` em
  `hub_checkout_sessions`.
- **Descrição** "Wise Wolf Hub - <plano> (MONTHLY|YEARLY)" para os planos do
  professor e "Wolfie AI Tutor - <plano>" para o Wolfie avulso
  (`provider_subscription_description` em `create-hub-checkout`).
- O cliente no Asaas é o da conta do Hub (`hub_accounts.asaas_customer_id`),
  não um aluno da escola.
- Para casar uma linha do extrato com o livro:

```sql
select c.id as checkout_id, c.product_family, c.amount, c.status,
       p.provider_payment_id, p.status as pagamento, p.applied_at, p.reversed_at
from public.hub_checkout_sessions as c
left join public.hub_subscription_payments as p on p.checkout_id = c.id
where c.id = '<uuid depois de hub:>'::uuid;
```

## 4. Avisos

1. **O saldo do Asaas mistura dinheiro da escola e da plataforma.** O saldo
   disponível e os saques não dizem de quem é o dinheiro. Antes de sacar ou de
   conferir o saldo com o caixa da escola, desconte o `liquido` do Hub do mês
   (e as tarifas do Asaas sobre essas cobranças).
2. **Não lance o Hub em `financial_transactions`.** O caixa e o DRE da escola
   passariam a contar a plataforma como receita da escola, e a conciliação do
   caixa acusaria divergência contra o Asaas.
3. **Não lance o Hub em `student_payments`.** Ali o pagamento dispara caixa
   (`trg_ledger_on_payment`), aviso de **rateio** no grupo
   (`trg_notify_payment_split` — dízimo, investimento e pró-labore calculados
   sobre um dinheiro que não é da escola) e indicação
   (`trg_grant_referral_reward`).
4. **Não "conserte" um `PRODUCT_PAYMENT_MISSING_LOCAL` criando linha na mão.**
   O livro do Hub só nasce pelo webhook (`hub_activate_paid_checkout`), que
   também cria o período de acesso. Um insert manual daria dinheiro sem acesso
   ou acesso sem a trava de idempotência por pagamento.
5. A consulta mensal é a fonte para o contador até haver decisão diferente.
   Guarde o resultado de cada mês (planilha ou PDF) — ela é recalculada sobre o
   livro atual, e um estorno tardio muda o mês do estorno, não o mês original.

## 5. Alternativas para o contador

### Opção B — conta própria no DRE, mesma conta Asaas

Criar no plano de contas uma receita separada (ex.: `3.2.01 Receita da
plataforma — Hub`, `kind = RECEITA`, `ledger_allowed = false`) alimentada
**direto** de `hub_subscription_payments`, sem lançamento no caixa da escola.

- ⚠️ `dre_gerencial` **e** `get_cashflow` precisam passar a ler o Hub **no mesmo
  commit**, com a mesma regra de status e de data. Este projeto já pagou caro
  por duas telas com fontes diferentes para "quanto entrou" (ver "Conciliação do
  caixa Asaas" no `CLAUDE.md`); mudar só um lado reabre o problema.
- `ledger_allowed = false` impede que alguém lance a mesma receita também pelo
  caixa (dupla contagem).
- A conciliação do caixa da escola continuaria sem o Hub; o DRE ganharia uma
  linha "da plataforma" separada do resultado da escola.
- Custo: uma migration com as duas funções e testes de DRE/caixa. Não muda o
  saldo misturado do Asaas.

### Opção C — conta Asaas (e CNPJ) próprios da plataforma

Abrir uma conta Asaas para a plataforma — idealmente com CNPJ próprio — e
apontar o checkout do Hub para ela.

- Separa de verdade saldo, saque, tarifa, nota fiscal e tributação.
- É a única que resolve o aviso 1 (saldo misturado).
- Custo: credencial e webhook novos para a integração da plataforma (o Hub já
  resolve o Asaas por `resolvePlatformAsaasIntegration`, modo
  `PLATFORM_MANAGED_ROOT`, em `_shared/tenant-integration-broker.ts`; hoje ela
  aponta para a conta Asaas da escola), um webhook que saiba de qual conta veio
  cada evento, migrar ou encerrar as assinaturas que existirem na conta antiga e
  decidir a emissão de nota.
- Decisão contábil e societária: o contador indica se faz sentido CNPJ próprio
  e qual regime.

| | A (vigente) | B | C |
|---|---|---|---|
| Separa o resultado | por consulta | no DRE | por conta |
| Separa o saldo do Asaas | não | não | sim |
| Mexe em código | não | DRE + caixa juntos | integração do Asaas |
| Risco de dupla contagem | baixo, se ninguém lançar à mão | baixo com `ledger_allowed = false` | nenhum |
