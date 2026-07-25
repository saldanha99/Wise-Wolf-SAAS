# Auditoria pós-deploy — Professor

Data: 2026-07-24

Ambiente: produção

Perfil: `TEACHER`

Viewports principais: desktop 1440×900 e mobile 390×844

## Resultado

**Aprovado após as correções.**

Foram abertas as 20 rotas disponíveis no menu do Professor e a tela de Perfil
no mobile. Todas mantiveram largura responsiva, sem alerta inesperado,
exceção de página ou erro relevante no console.

Os fluxos de Financeiro e geração de relatório também foram retestados em
desktop.

## Validações

- Todos os itens inferiores da sidebar ficaram alcançáveis.
- O menu pode ser percorrido por teclado e não conflita com o rodapé.
- Financeiro abre pela navegação principal.
- O modal de período do relatório abre e fecha corretamente.
- **GERAR PDF** usa um iframe oculto e preserva a rota, o shell autenticado e
  a tela de Financeiro.
- O Wolfie apresenta um estado vazio válido, sem erro UUID/HTTP 400.
- O Perfil e as 20 rotas não apresentam estouro horizontal em 390×844.

## Regressões encerradas

| Regressão | Situação final |
|---|---|
| Frontend não inicializava em produção | Corrigida |
| Wolfie falhava com tenant textual em coluna UUID | Corrigida |
| Módulos inferiores inacessíveis na sidebar | Corrigida |
| Geração de PDF substituía o aplicativo | Corrigida |
| Gráficos iniciavam sem dimensões válidas | Corrigida |

## Evidências

- [Dashboard final](teacher-f939-dashboard-clean.png)
- [Menu mobile no último item](teacher-final-mobile-menu-end.png)
- [Financeiro mobile](teacher-final-mobile-finance.png)
- [Modal do relatório](teacher-d23-report-modal-final.png)
- [Aplicativo preservado após PDF](teacher-d23-after-pdf-final.png)
- [Perfil mobile](teacher-d23-mobile-profile-final.png)
- [Wolfie em estado vazio](teacher-final-wolfie-empty.png)

## Limpeza

A conta, a sessão, os tokens, o perfil e o tenant exclusivos desta auditoria
foram removidos depois do backup. A varredura estrutural e de payloads de log
retornou zero resíduos.
