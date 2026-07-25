# Matrícula pública E2E — produção

Data: 2026-07-24

Ambiente: produção

Release: `31b02c0`

Viewport: 390×844

Identidade: CPF de teste autorizado em `docs/runbooks/e2e-test-identities.md`

## Resultado

**Aprovado.**

O fluxo chegou ao último botão, **FINALIZAR MATRÍCULA**, e exibiu
**Matrícula Confirmada!**. O processamento terminou em uma tentativa e sem
erro.

## Preparação isolada

- E-mail único por execução.
- Oferta, oportunidade e link exclusivos.
- Recursos marcados com `testMode` e `test_fixture`.
- Notificações externas desativadas antes do início.
- Plano de um mês, uma aula por semana e taxa de matrícula de R$ 0,00.
- Cobrança mínima aceita pelo sistema: R$ 5,00.
- Nenhum perfil local e nenhum cliente Asaas para o CPF antes do fluxo.

## Etapas validadas

1. Abertura do link exclusivo e carregamento do bundle final.
2. Seleção de Pix.
3. Preenchimento e validação dos dados.
4. Revisão da ficha de matrícula.
5. Abertura e leitura do contrato.
6. Assinatura digitada com o nome completo.
7. Aceite dos termos.
8. Clique no botão **FINALIZAR MATRÍCULA**.
9. Estado de processamento sem permitir clique duplicado.
10. Tela **Matrícula Confirmada!**.
11. Recarga do mesmo link mantendo o sucesso.

## Idempotência e persistência

Depois da conclusão e novamente após a recarga, existiam:

- uma conta Auth;
- um perfil de Aluno marcado como teste;
- um cliente Asaas;
- uma assinatura Asaas;
- uma cobrança Pix pendente de R$ 5,00;
- um registro local de pagamento;
- uma oferta consumida e um link usado.

Não houve duplicação.

## Supressão de notificações

Antes da limpeza, as consultas retornaram:

| Canal | Quantidade |
|---|---:|
| Fila de notificações | 0 |
| Notificações internas | 0 |
| Mensagens WhatsApp | 0 |
| Outbox WhatsApp | 0 |
| Log geral de WhatsApp | 0 |

O cliente Asaas permaneceu com notificações desativadas. Isso confirma a
correção do trigger que antes podia criar uma mensagem transitória durante a
matrícula de fixture.

## Limpeza

Foi criado um backup pós-sucesso antes de qualquer exclusão. Em seguida:

- a cobrança Asaas foi excluída;
- a assinatura Asaas foi excluída;
- o cliente Asaas foi excluído;
- sessões e tokens Auth foram revogados;
- identidade e usuário Auth foram removidos;
- pagamento local, perfil, auditorias, oportunidade, oferta e link foram
  removidos.

A validação final encontrou:

- zero cliente Asaas ativo pelo CPF;
- os três IDs Asaas com `deleted=true`;
- zero ocorrência por CPF, e-mail, IDs, correlação ou chave de fixture no
  banco e Auth;
- zero ocorrência nos payloads de logs.

Backup mantido na VPS:

`/opt/wisewolf/backups/e2e-enrollment-20260725/20260725T011056Z-31b02c0`

O diretório é restrito e seus checksums foram validados.

## Evidências

- [Link inicial](enrollment-31b-initial-mobile.png)
- [Pix selecionado](enrollment-31b-pix-selected-mobile.png)
- [Formulário preenchido](enrollment-31b-form-filled-mobile.png)
- [Revisão](enrollment-31b-review-mobile.png)
- [Contrato](enrollment-31b-contract-mobile.png)
- [Pronto para finalizar](enrollment-31b-ready-to-finalize-mobile.png)
- [Sucesso](enrollment-31b-success-mobile.png)
- [Sucesso após recarga](enrollment-31b-success-reload-mobile.png)
