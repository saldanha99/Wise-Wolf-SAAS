# Wolfie Visual Assets V3 — vida cotidiana e treino de fala

> Versão: 3
> Data: 1º de agosto de 2026
> Estado: publicado em produção na release `20260802T033326Z-5a9a6fe506fc`
> Escopo: seis experiências de vida cotidiana e quatro experiências de fala

## 1. Resumo

O lote V3 acrescenta dez ambientes originais ao Wolf Tutor:

- vida cotidiana: `home-organization`, `skincare-beauty`, `health-symptoms`,
  `shopping`, `services` e `digital-life`;
- fala: `record-a-story`, `tell-a-story`, `describe-what-you-see` e
  `give-your-opinion`.

Os fundos foram produzidos com o ImageGen integrado ao Codex como ambientes 3D
cinematográficos realistas estilizados. A Praktika foi usada somente como
referência conceitual de presença e imersão. Nenhum asset, personagem, sala,
interface, paleta ou composição proprietária foi reproduzido.

As imagens não contêm aluno, pessoa, rosto, mão, marca, logo, texto rasterizado,
dado pessoal, dado clínico, identidade de empresa ou interface embutida. Todo
conteúdo pedagógico, legenda e controle permanece em HTML acessível. As fontes
aprovadas são preservadas fora do runtime; apenas os WebPs finais em
`public/assets/wolfie/` são consumidos pela aplicação.

## 2. Inventário final

| Experiência | Fonte ImageGen aprovada | Desktop | Mobile |
|---|---|---|---|
| `home-organization` | `exec-1f8de380-8558-4e20-8a2b-6a9ed5013168.png` | `desktop.7c4dc9c47869.webp` | `mobile.cf5219047081.webp` |
| `skincare-beauty` | `exec-1079eb08-a8bc-4ceb-b393-980272acd727.png` | `desktop.d33a51897720.webp` | `mobile.8fcf4cb6fee3.webp` |
| `health-symptoms` | `exec-80e61547-744c-4ae5-bcfe-8bb0bcdc2eb8.png` | `desktop.9adfe824b04d.webp` | `mobile.a477b7fe8b5c.webp` |
| `shopping` | `exec-593f1243-cc43-4716-9081-7929b8de1ae3.png` | `desktop.51815cc63841.webp` | `mobile.3ef46a1b80b4.webp` |
| `services` | `exec-50886195-fcf0-4710-b2be-d879e965f7dd.png` | `desktop.f4718b4b2fcc.webp` | `mobile.b8270b819e69.webp` |
| `digital-life` | `exec-ef9c4333-5150-4e01-820f-668f8f5ed136.png` | `desktop.3ec843995374.webp` | `mobile.ebbb0f52717c.webp` |
| `record-a-story` | `exec-db74f2b1-b14f-47b7-87f9-049203cb207b.png` | `desktop.33ed5d04f71d.webp` | `mobile.a54947aec928.webp` |
| `tell-a-story` | `exec-cd6254e1-f28a-4805-84f3-69db982672be.png` | `desktop.b202bb21a980.webp` | `mobile.f75e67227d30.webp` |
| `describe-what-you-see` | `exec-4f8a0c0b-ee32-46a4-8b61-dce5776d7b02.png` | `desktop.26949399b48b.webp` | `mobile.1d72d75ed0dc.webp` |
| `give-your-opinion` | `exec-c1a5ab30-76f0-4c06-8d08-e6e80a6cf863.png` | `desktop.66b5facc2154.webp` | `mobile.0c7e85d2a251.webp` |

Todas as fontes aprovadas possuem `1672 × 941`. Cada uma originou:

- desktop `1600 × 900`, WebP, orçamento máximo de 320.000 bytes;
- mobile `900 × 1200`, WebP, orçamento máximo de 180.000 bytes;
- crop central inspecionado para manter contexto e espaço útil para o
  personagem, HUD, legenda e controles.

## 3. Prompt-base

```text
Use case: stylized-concept.
Asset type: full-screen background for a Wolf Tutor interactive English
training experience.

Create an original premium 3D environment in cinematic stylized realism, with
convincing materials, human eye-level camera and clear foreground, midground and
background. Deliver the environment only: no character and no interface.

Use a widescreen 16:9 composition. Reserve the requested third as a calm,
low-contrast open zone for a later full-body interactive character. Keep the
central crop meaningful at mobile 3:4 and preserve calm zones for accessible
HTML HUD, captions and controls.

Do not include people, identifiable faces, hands, bodies, silhouettes,
embedded text, pseudo-text, glyphs, letters, numbers, logos, brands,
trademarks, flags, watermarks, readable documents, readable screens, charts,
personal data, company identity, character or interface. Do not imitate or
reproduce any Praktika asset or composition.
```

## 4. Direções aprovadas

| Experiência | Direção combinada com o prompt-base |
|---|---|
| `home-organization` | Apartamento funcional e acolhedor, madeira clara, cestos e nichos organizados; parede esquerda calma para o personagem; sem etiquetas ou embalagens. |
| `skincare-beauty` | Showroom sereno de beleza, bancada curva, espelho e recipientes cerâmicos totalmente neutros; região esquerda leve; sem rótulo, marca ou reflexo humano. |
| `health-symptoms` | Sala de consulta acolhedora, duas poltronas, madeira e azul suave; grande parede direita calma; sem paciente, profissional, anatomia, medicamento, prontuário ou alegação clínica. |
| `shopping` | Boutique contemporânea genérica, balcão, roupas e bolsas sem identidade visual; corredor esquerdo livre; sem etiqueta, preço, manequim ou pessoa. |
| `services` | Balcão premium de atendimento genérico com lounge ao fundo e parede direita livre; sem placa, formulário, terminal legível, marca ou empresa. |
| `digital-life` | Estação doméstica de tecnologia com monitor e telefone em gradiente abstrato, mesa limpa e região esquerda mais calma; sem sistema operacional, aplicativo, teclado legível, dado ou marca. |
| `record-a-story` | Estúdio de gravação vazio, palco íntimo, câmera abstrata e painel totalmente limpo; terço esquerdo escuro e calmo; sem indicador, texto ou interface. |
| `tell-a-story` | Palco narrativo abstrato com arcos, tecidos e luz quente; região direita sóbria; sem pessoa, livro aberto, letra ou símbolo. |
| `describe-what-you-see` | Galeria de observação com grande painel branco vazio e quatro objetos escultóricos distintos; terço esquerdo mais calmo; sem legenda, sinalização ou obra protegida. |
| `give-your-opinion` | Lounge de conversa e podcast, duas poltronas e microfones genéricos à esquerda, grande área azul à direita; sem marca, tela, pessoa ou sinalização. |

## 5. Decisões conservadoras de QA

- A primeira tentativa de `skincare-beauty`,
  `exec-e9081fb8-11cb-4bcc-acea-20d8d5d0b881.png`, foi rejeitada por conter
  rótulos artificiais sutis nas embalagens.
- A primeira tentativa de `digital-life`,
  `exec-4794ae28-4b85-4203-9a0a-cf4b8b5dea10.png`, não foi escolhida porque
  exibia um teclado desnecessário e elevava o risco de pseudotexto. A versão
  final remove esse elemento.
- Uma segunda composição válida de `give-your-opinion` foi arquivada sem uso;
  a escolhida oferece a melhor área livre para o personagem à direita.

## 6. Checksums e orçamento

| Experiência | Desktop: bytes / SHA-256 | Mobile: bytes / SHA-256 |
|---|---|---|
| `home-organization` | 138.518 / `7c4dc9c47869f82cfd726c4619ed2c12595f0a20e7bb6f1cc19700c28d895b59` | 79.668 / `cf52190470819c09eaea02f5dff1559fa932580789491337e27b35a1e4ed6155` |
| `skincare-beauty` | 72.888 / `d33a51897720c3f2a7e335e9a4ccdce74dfece037ca8eb81b8d873ad11093860` | 25.954 / `8fcf4cb6fee3835fe2cda91a22912adcc8cd0c0d3be7bbcea4af6c8b11878916` |
| `health-symptoms` | 110.976 / `9adfe824b04deb18cd6923cabf981ae5a14c4e295f333ac4d26e88818f2471a2` | 68.136 / `a477b7fe8b5c9cb0517ff5d0092dc96a451f0cdf9f92fd5cc71cb5d0398ce4b9` |
| `shopping` | 88.326 / `51815cc638414331d064a55d740f8b7e7df81325acbbae8dfcc49941552ec2ed` | 53.724 / `3ef46a1b80b414165a7df4496e4db19f40bded8dd84a195731997d0f87b7e895` |
| `services` | 78.370 / `f4718b4b2fcc0611cac1d0c06874f5cca26678af7cd47938409c85b32b17d323` | 34.106 / `b8270b819e69e1cb75fa4332eb9c43e520e4e01324ad14cad7a9f4475a94a1b5` |
| `digital-life` | 45.316 / `3ec8439953744f22459c8bf6d9d92eff37492e810e6012e344c24f1d00726550` | 22.348 / `ebbb0f52717c0b72b3396b42cb182f98fec5fdaeebf4d05fb8f465fe6d7e65b6` |
| `record-a-story` | 55.092 / `33ed5d04f71dace087443bf74d7c33c22e07df6e95e04e0234c7157020632d4d` | 26.798 / `a54947aec928c0dd0638c3fabe3b676c5e82cf25030dbf1188348866971321c2` |
| `tell-a-story` | 65.756 / `b202bb21a9801e338a16c70be53328e6b5a75bfeafaab4b106fa513164f70342` | 31.476 / `f75e67227d301494cc5c2a7edf94fde11960a9ad7a5946de7cd096099a7895b1` |
| `describe-what-you-see` | 45.228 / `26949399b48b569315d803d09fccf36438ba25eacc985039f7263eb062c3e4eb` | 26.018 / `1d72d75ed0dcba62b59598050871450305c2249f788181975075135c226a40c6` |
| `give-your-opinion` | 51.130 / `66b5facc2154ff7dcdc58fe9ea85b1b6dddf776b54f62040af15d28724f93a45` | 27.506 / `0c7e85d2a25170225d3eec60454f330b0c874fc6dbfd246b6623fb237053a67e` |

## 7. QA e rollout executados

Concluído antes do rollout:

- inspeção individual das dez fontes desktop;
- inspeção conjunta e individual dos dez recortes mobile;
- 10 testes focais do manifesto e catálogo aprovados;
- suíte completa com 60 testes do frontend aprovada;
- typecheck aprovado;
- build de produção aprovado com a interface V2 ativa;
- 82/82 caminhos verificados em `public`: 57 assets primários e 25 aliases de
  transição;
- 82/82 caminhos verificados novamente no pacote `dist`;
- dimensões, orçamento, fingerprint e SHA-256 travados no manifesto;
- decodificação WebP real e integridade RIFF confirmadas pelo verificador;
- QA integrado aprovado para os dez cenários em `1440 × 900` e `390 × 844`:
  fundo correto, personagem correto, ausência de overflow horizontal e imagens
  integralmente carregadas;
- 20 combinações responsivas verificadas em uma única sessão headless, com uma
  única página, zero erro de página e zero erro de console;
- navegador headless encerrado, sem sessão automatizada residual;
- nenhum texto, logo, marca, pessoa ou dado detectado na revisão visual.

Rollout concluído em 2 de agosto de 2026, às 03:33 UTC (00:33 BRT):

- commit de origem `00a5908f5e7b`;
- release ativa `20260802T033326Z-5a9a6fe506fc`;
- backup reversível
  `/opt/wisewolf/backups/release-20260802T033326Z-5a9a6fe506fc`;
- feature flag `VITE_WOLFIE_SCENARIO_UI_V2=true` preservada;
- preflight da VPS, 60 testes do frontend, 166 testes Deno, checks das funções
  e build de produção aprovados;
- suítes SQL transacionais concluídas com `ROLLBACK`;
- marcador remoto apontando exatamente para a release ativa;
- frontend e Hub em `200`, além dos três preflights do Wolfie em `200`;
- 82/82 URLs conferidas novamente fora do processo de release, com MIME
  `image/webp`, bytes e SHA-256 idênticos ao manifesto;
- os 20 novos recortes, o personagem fingerprintado e um alias legado foram
  carregados como imagens reais em uma única página headless de produção, com
  dimensões corretas, zero erro de página e zero erro de console;
- sessão headless encerrada e nenhuma sessão automatizada residual.

Com este lote, 28 dos 56 cenários canônicos possuem bitmap próprio. Os outros
28 continuam usando o fallback visual determinístico até os lotes seguintes.
