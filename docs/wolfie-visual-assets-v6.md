# Wolfie Visual Assets V6 — carreira e eventos finais

> Versão: 6
> Data: 2 de agosto de 2026
> Estado: integração e QA local aprovados; rollout final pendente
> Escopo: três experiências de carreira e três experiências de eventos

## 1. Resumo

O lote V6 completa os seis ambientes que ainda usavam fallback:

- carreira: `first-job`, `multinationals` e `career-change`;
- eventos: `events-networking`, `panels` e `poster-presentation`.

Com a integração deste lote, as 56 experiências canônicas do Wolf Tutor passam
a ter fundo bitmap próprio em desktop e mobile. Os fallbacks determinísticos
continuam preservados como proteção de carregamento e erro, mas nenhum cenário
canônico depende deles por falta de asset.

Os fundos foram produzidos com o ImageGen integrado ao Codex em realismo 3D
estilizado e cinematográfico. A Praktika serviu apenas de referência conceitual
de imersão. Nenhum asset, personagem, cenário, interface, paleta ou composição
proprietária foi reproduzido.

As cenas contêm apenas ambientes e objetos inanimados. Não há pessoas, corpos,
partes humanas, silhuetas, personagens, texto, pseudotexto, glifos, números,
logos, marcas, bandeiras, telas, interfaces, documentos, mapas ou gráficos.

## 2. Inventário integrado

| Experiência | Fonte ImageGen aprovada | Desktop | Mobile |
|---|---|---|---|
| `first-job` | `exec-8f67529d-12cc-44a8-ba6d-d6b697f23e4a.png` | `desktop.1651a307b792.webp` | `mobile.6bf3c53c11ee.webp` |
| `multinationals` | `exec-45d5d953-72cb-459e-910c-037181f4d44a.png` | `desktop.8b9b0d4d2087.webp` | `mobile.ac1652aa438c.webp` |
| `career-change` | `exec-426e82d7-0193-43dd-a0ff-60d5dd5ff9d3.png` | `desktop.7582d772abe5.webp` | `mobile.a6a7a558810e.webp` |
| `events-networking` | `exec-3f88929a-0b2e-40ad-911d-be2d944b950c.png` | `desktop.9e608ec4862d.webp` | `mobile.7b704231f47f.webp` |
| `panels` | `exec-80f8205d-9a77-4b51-99a7-cbbd0c051d50.png` | `desktop.6bc6a1b1371e.webp` | `mobile.64c50a1eabaa.webp` |
| `poster-presentation` | `exec-f1e01681-377f-49e5-a228-7a525d2c00a7.png` | `desktop.32c7fcc8fc4c.webp` | `mobile.124b0d4af912.webp` |

Todas as fontes aprovadas possuem `1672 × 941`. Cada fonte gerou um WebP
desktop `1600 × 900` e um WebP mobile `900 × 1200`. O recorte central exato
`706 × 941` foi inspecionado antes da conversão.

## 3. Prompt-base

```text
Create one entirely original premium cinematic stylized-realistic 3D
environment with convincing materials, human-eye-level camera, and clear
foreground, midground, and background. Render the environment and inanimate
props only.

Use a widescreen 16:9 composition. Reserve the specified side third as a calm,
low-contrast open zone for a separate application overlay. Keep the central
42% complete and meaningful so a centered 3:4 mobile crop preserves the scene
identity and main spatial cue.

No people, faces, hands, bodies, body parts, humanoid forms, silhouettes,
crowds, mannequins, dolls, avatars, mascots, figurines, creatures, characters,
text, pseudotext, glyphs, letters, numbers, signage, labels, posters,
nameplates, readable documents, maps, diagrams, charts, routes, data, screens,
interfaces, HUD, UI, logos, brands, trademarks, flags, watermarks, recognizable
products or identifiable landmarks. Do not imitate any third-party work.
```

## 4. Direções aprovadas

| Experiência | Direção visual aprovada |
|---|---|
| `first-job` | Suíte acolhedora de onboarding com mesa em madeira clara, duas relações de assento, luminária, planta e divisória de vidro; área esquerda calma. |
| `multinationals` | Sala global de colaboração vazia com mesa circular, assentos em múltiplas direções, painéis de luz arquitetônicos e dois vãos abstratos; área direita calma. |
| `career-change` | Galeria de estratégia com três caminhos arquitetônicos e três portas iluminadas, sem seta, placa ou símbolo; área esquerda calma. |
| `events-networking` | Lounge noturno de conferência com mesas altas, grupos de poltronas vazias, plantas e escultura curva de luz; área direita calma. |
| `panels` | Palco vazio com quatro poltronas, duas mesas lisas, backdrop acústico e degraus; área direita calma. |
| `poster-presentation` | Galeria acadêmica com suporte vertical totalmente vazio e suas quatro bordas visíveis, base lisa e alcova; área direita calma. |

## 5. Decisões conservadoras de QA visual

- Uma primeira fonte de `first-job` foi rejeitada porque a planta desaparecia
  no recorte mobile.
- Duas composições de `career-change` foram descartadas porque preservavam
  somente uma porta completa; uma terceira tinha bom enquadramento, mas saiu em
  proporção `1448 × 1086`, fora do `16:9` obrigatório.
- Três tentativas de `panels` foram rejeitadas porque o recorte mobile mantinha
  apenas duas poltronas inteiras. A fonte final preserva três completas, parte
  da quarta, ambas as mesas, a curva do palco e o backdrop.
- A primeira fonte de `poster-presentation` perdeu a borda esquerda do suporte
  no recorte. A versão final mantém as quatro bordas, a base e o contexto.

## 6. Checksums das fontes aprovadas

| Experiência | SHA-256 da fonte `1672 × 941` |
|---|---|
| `first-job` | `64c7b2bdd080998797a8ec619fa5a1f0f46ba4018d150aba27dacc9a84e458a7` |
| `multinationals` | `5c8db3434865e00be55f051a677d99262b7e50b94e13ee6e3192385e6a74fc6e` |
| `career-change` | `f7474c29b03996c282bb699930535e4ce0bb171c3a8d71291cf91f47c7d22b1f` |
| `events-networking` | `985b07ddceb6dcb4ce24b37d683b7747a936fed5a8f5f57b9867f2216e2637b8` |
| `panels` | `7b9a20a61fc25d16362eb6a45e30e97aa5b2ac1c36803f8bb03ef4d9ecba40ec` |
| `poster-presentation` | `8f8a5aad32669a70f24e6800b0c7bfa7da72c9a8eeb52afd43677164c8ede7b3` |

## 7. Checksums e orçamento dos WebPs

| Experiência | Desktop: bytes / SHA-256 | Mobile: bytes / SHA-256 |
|---|---|---|
| `first-job` | 99.338 / `1651a307b792cbd3a8dcf8ba215b48a25d9e19abf3a582fb2db0972aea5126dd` | 63.268 / `6bf3c53c11ee7f5d23d17288b38890a9f7c321066a5c364aa67e4d9e053db5e7` |
| `multinationals` | 119.734 / `8b9b0d4d2087a9fdf57f1678992db7896a6e0bd7014224c18aefb9ef03b1a4a2` | 58.982 / `ac1652aa438caa84bdd2679a72d4a31129cbcf9a3d5fbdeb9ae62a211d77a179` |
| `career-change` | 81.992 / `7582d772abe5eeeb9900af2b28658ecb286ae18dbba522ab59e4db54710fefd9` | 48.730 / `a6a7a558810e848b1dacf310154adea4e0aeefc6bf53792ba8251fe050b764ca` |
| `events-networking` | 99.956 / `9e608ec4862d46100b2c5cd71550abfa0637e288e3c6bb410cf49a7a5f2aa560` | 56.782 / `7b704231f47f620b81c998ffa0bbdd1a46a0dc1ba9d01ba4047877ef9974a8f9` |
| `panels` | 63.510 / `6bc6a1b1371eff4263172da51da7ca834c100fa76a35bb6cd057d857828975eb` | 39.582 / `64c50a1eabaa2cc554a8ce50b553a15c93cc27e2a9d7923b9ffc14711732bd7d` |
| `poster-presentation` | 42.762 / `32c7fcc8fc4c30de1a680f4b1345bdca880e0340b25d22a8b8b41af9aa1cb76c` | 22.762 / `124b0d4af912382eb10f6bd1fdeba9f741a091a6b4c3b8bb3b185d3aaf34a845` |

Os nomes fingerprintados correspondem aos primeiros 12 caracteres do SHA-256.
Todos os desktops estão abaixo de 320.000 bytes e todos os mobiles abaixo de
180.000 bytes.

## 8. QA local concluído e rollout pendente

Gates concluídos:

- 10/10 testes focais do catálogo e manifesto;
- 60/60 testes da suíte frontend e typecheck sem erros;
- build de produção com a interface V2 ativa;
- 138/138 URLs verificadas em `public` e novamente em `dist`, incluindo 112
  fundos, um personagem e 25 aliases de transição;
- seis cenários percorridos em desktop `1440 × 900` e mobile `390 × 844`, na
  mesma página, em uma única sessão headless e uma única guia;
- fundo correto `1600 × 900` ou `900 × 1200`, personagem `1024 × 1536`, nenhum
  overflow horizontal, erro de página ou erro de console;
- sessão headless encerrada e nenhuma sessão automatizada residual;
- revisão independente de manifesto, fontes, 12 WebPs, recortes, hashes e
  limites sem achados de qualquer severidade.

O rollout final permanece pendente de versionamento deste lote e de uma janela
estável sem release externa concorrente. A publicação deve executar novamente
todos os gates do runbook, criar backup próprio e conferir externamente as 138
URLs por MIME, bytes e SHA-256 antes de considerar as 56 cenas ativas.
