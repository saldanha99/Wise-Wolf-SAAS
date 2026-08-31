# Fluxo autoritativo: experimental → feedback → matrícula

## Visão geral

```text
opportunity → appointment → class_log COMPLETED → trial_feedback
                                                    ↓
                                           offer + enrollment_link
                                                    ↓
                                      begin_enrollment_offer
                                                    ↓
                              profile STUDENT/PENDING + aceite
                                                    ↓
                                      cobrança / assinatura
                                                    ↓
                                    complete_enrollment_offer
                                                    ↓
                                  link USED + opportunity WON
```

O aluno não é criado durante a experimental nem quando a gestão gera a proposta. O perfil `STUDENT` nasce no início autoritativo da aceitação, ainda com situação financeira pendente; a oportunidade só é convertida depois da conclusão financeira da oferta.

## Regras de feedback

- Experimentais novas usam `opportunities.feedback_required = true`.
- Registros legados mantêm `feedback_required = false` e não ficam bloqueados retroativamente.
- Uma experimental obrigatória só libera a oferta depois de existir `trial_feedback` válido.
- O servidor continua sendo a barreira definitiva e responde `trial_feedback_required` se um cliente desatualizado tentar contornar a tela.
- A pendência do professor nasce apenas quando existe `class_logs.presence = 'COMPLETED'` para o `trial_appointment_id` e ainda não existe feedback.

## Etapas

### 1. Oportunidade e agendamento

A oportunidade é criada em `opportunities`. Quando um professor assume a experimental, o fluxo liga a oportunidade a um `appointment`, registra o professor responsável e mantém a conversão aberta.

Esse passo não cria perfil de aluno, contrato, oferta ou link de matrícula.

### 2. Lançamento da aula e feedback do professor

O professor lança a aula no `LessonLauncher`. A aula realizada é persistida em `class_logs`; mudar apenas um estado visual da oportunidade não é suficiente para criar uma pendência.

As pendências são lidas pela RPC `get_teacher_pending_trial_feedback_secure()`. Ela devolve somente as experimentais concluídas do professor autenticado e do seu vínculo ativo, sem liberar leitura direta de `opportunities` para o papel `TEACHER`.

O formulário salva pela RPC `update_trial_outcome_secure` com `action = 'SAVE_FEEDBACK'` e uma chave idempotente. Nível, plano recomendado, interesse e observações ficam em `trial_feedback`.

### 3. Proposta da gestão

O `TrialsToContracts` apresenta as experimentais ao time autorizado. Para registros com feedback obrigatório, a ação de matrícula permanece bloqueada até a avaliação existir; as experimentais legadas continuam com o comportamento anterior.

A criação chama `create_enrollment_offer(p_payload)`. A operação autoritativa:

1. valida escola, oportunidade, aula, professor, valores, vencimento e grade;
2. revoga a proposta aberta anterior da mesma oportunidade;
3. expira o link pendente anterior;
4. cria uma `offer` do tipo `ENROLLMENT`;
5. cria o `enrollment_link` correspondente.

A URL atual é `/matricula?offer=<uuid>`. Preço, agenda e termos não viajam em Base64 como fonte de verdade.

A tela só reaproveita/exibe um link quando link e oferta:

- pertencem à mesma escola e oportunidade;
- ainda estão dentro da validade;
- não foram revogados nem consumidos;
- permanecem no estado compatível com uma proposta aberta.

Oferta revogada/expirada ou link expirado não contam como proposta ativa. Se já houver uma matrícula realmente iniciada, o servidor responde `enrollment_in_progress` em vez de abrir uma segunda.

### 4. Matrícula do aluno

O `PublicRegistration` carrega a oferta normalizada pelo servidor. Depois da autenticação do aluno, `begin_enrollment_offer` reserva a oferta, cria ou atualiza o perfil `STUDENT` com situação financeira pendente e grava o aceite de forma retomável. A integração financeira cria/confirma a cobrança conforme os termos salvos.

Somente a conclusão autoritativa (`complete_enrollment_offer`) fecha oferta/link, converte a oportunidade para `WON` e efetiva os efeitos posteriores, como indicação e comissão. Falha de pagamento ou interrupção pode deixar um perfil pendente para retomada, mas não deve simular uma conversão concluída.

## Automação pós-experimental

O `post-trial-pipeline` é executado periodicamente. Ele considera a evidência de aula concluída, respeita `feedback_required` e distingue:

- experimental concluída sem feedback obrigatório;
- experimental concluída sem proposta utilizável;
- proposta válida parada;
- matrícula iniciada/concluída.

Uma oferta revogada/expirada não pode suprimir o acompanhamento como se ainda fosse utilizável.

## Fontes de verdade

| Fato | Fonte autoritativa |
|---|---|
| Professor e horário da experimental | `appointments` ligado por `trial_appointment_id` |
| Aula efetivamente realizada | `class_logs` com `presence = 'COMPLETED'` |
| Avaliação pedagógica | `trial_feedback` |
| Termos comerciais | `offers.payload` normalizado pelo servidor |
| Link operacional | `enrollment_links` junto da oferta correspondente |
| Matrícula em andamento | estado autoritativo de oferta/link/tentativa |
| Aluno convertido | conclusão da oferta + `opportunities.conversion_status = 'WON'` |

## Estados e mensagens esperadas

| Situação | Comportamento |
|---|---|
| Aula ainda não lançada | não aparece como feedback pendente |
| Aula concluída, feedback obrigatório ausente | professor vê pendência; gestão não gera proposta |
| Experimental legada sem obrigatoriedade | gestão pode seguir sem feedback |
| `trial_feedback_required` | orientar a solicitar/concluir o feedback |
| `enrollment_in_progress` | informar que já existe matrícula em andamento |
| Link ou oferta revogada/expirada | ignorar e permitir que a gestão revise o próximo passo |
| Oferta concluída | link encerrado e oportunidade convertida |

## KPIs

Os KPIs devem ser derivados dos estados autoritativos. Em especial, “links enviados” não deve tratar oferta revogada/expirada como proposta ativa, e “convertidos” deve usar a conversão concluída, não apenas a criação do link.
