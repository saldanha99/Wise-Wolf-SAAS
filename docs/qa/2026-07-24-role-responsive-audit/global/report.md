# Auditoria exploratória — Acesso público

Data: 2026-07-24
Ambiente: produção
Escopo: tela de login sem sessão.

## Cobertura

| Viewport | Resultado |
|---|---|
| Desktop 1440 × 900 | Formulário completo, sem overflow |
| iPhone 12 | Formulário completo, sem overflow |
| Mobile 360 × 800 | `scrollWidth = clientWidth = 360`; nenhuma ação cortada |

Os campos de e-mail e senha usam fonte de `16px` e altura de `48px` no
viewport de 360 × 800, evitando zoom automático do navegador e mantendo uma
área de toque adequada.

## Evidências

- [Login desktop](screenshots/login-desktop.png)
- [Login iPhone 12](screenshots/login-mobile.png)
- [Login 360 × 800](screenshots/login-mobile-360x800.png)

## Observação de melhoria

Não foi encontrado defeito responsivo bloqueante no login. Em desktop, o
cartão ocupa uma parcela pequena da área disponível e deixa muito espaço sem
função. Uma evolução futura pode aproveitar esse espaço com uma mensagem de
boas-vindas, estado operacional ou ajuda curta, sem aumentar a complexidade
do formulário.
