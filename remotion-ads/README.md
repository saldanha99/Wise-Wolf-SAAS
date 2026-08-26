# Anúncios Meta — Wise Wolf

Vídeos para Meta Ads (Facebook e Instagram) em duas frentes, nos três formatos que cobrem
todos os posicionamentos.

| Frente | Público | Destino | Anúncios |
|---|---|---|---|
| **A — Alunos** | quem quer aprender inglês (online) | `/new-student` | 3 ângulos |
| **B — Escolas** | dono de escola de idiomas | `/new-saas` | 3 ângulos |

Cada anúncio é renderizado em **9:16**, **4:5** e **16:9** = 18 arquivos.

---

## Por que este projeto vive fora de `remotion/`

Não é organização: é uma trava de deploy.

`computeCompositionSourceSha256` (`remotion/scripts/render-provenance.ts:124`) hasheia
**todo** arquivo `.ts`/`.tsx`/`.json` sob `remotion/` e **todo** arquivo sob
`remotion/public/`. Esse hash entra nos receipts comerciais dos 5 filmes institucionais.

Qualquer arquivo novo ali dentro invalida os 5 receipts, faz
`npm run video:validate -- --public` falhar, e esse comando é a **primeira** coisa que o
`deploy/vps/release.sh` roda (linhas 173 e 692), antes de tocar a VPS. Ou seja: criar os
anúncios dentro de `remotion/` **derrubaria o deploy da produção**.

Por isso `remotion-ads/` tem raiz, `tsconfig.json`, `remotion.config.ts` e `public/`
próprios. Os filmes institucionais continuam intocados.

---

## Zonas seguras da Meta — o motivo técnico principal

A Meta reserva, no 9:16, **14% do topo, 35% da base e 6% de cada lado** para a própria
interface (perfil no topo; curtir/comentar/compartilhar, legenda do criador e botão de CTA
na base). Em 1080x1920 isso é **269px no topo, 672px na base e 65px nos lados** — sobra
útil de **950x979**.

⚠️ **O pipeline institucional não respeita isso.** `remotion/components/CaptionLayer.tsx:56`
posiciona a legenda queimada em `bottom: 122` no formato story. A faixa reservada da base
tem 672px, então aquela legenda fica **550px dentro da área tapada**: os 5 stories já
renderizados têm a legenda coberta pela interface do Reels. Não existe nenhuma constante de
zona segura em `remotion/` (grep por `SAFE`/`safeZone`: zero ocorrências).

Aqui a zona segura é a **origem das coordenadas**, não um ajuste posterior:

- `meta/safeAreas.ts` calcula a caixa segura por formato.
- `components/layout.ts` ainda reserva `markHeight` para o logotipo de canto e devolve
  `contentTop`/`contentHeight` — é isso que evita a colisão texto × logotipo que os filmes
  institucionais têm nas cenas Product e Proof.
- `meta/safeAreas.test.ts` trava tudo isso com 13 testes, incluindo um que **reprova**
  explicitamente um elemento posicionado como a legenda do pipeline institucional.

Só o **texto** precisa ficar fora da faixa reservada. A **imagem** continua preenchendo o
quadro inteiro — deixar a base preta desperdiçaria o quadro em quem assiste no Feed, onde a
sobreposição é bem menor.

---

## Formatos e cobertura de posicionamento

| Formato | Resolução | Cobre |
|---|---|---|
| `reels` | 1080x1920 (9:16) | IG Reels, IG Stories, FB Reels, FB Stories, IG Feed vídeo |
| `feed` | 1080x1350 (4:5) | FB Feed vídeo, IG Feed |
| `wide` | 1920x1080 (16:9) | In-stream, Facebook Video Feeds, reaproveitamento em site |

Os três são **composições próprias, não recortes**: o 9:16 tem 35% de base reservada e o
16:9 tem duas colunas. Recortar um do outro joga o texto para fora ou para dentro da faixa
coberta.

---

## Honestidade das afirmações

Cada roteiro carrega um campo `claims`, com a **origem de cada afirmação**. Nada entra no
anúncio sem constar ali. Os números da Frente B foram lidos direto do banco de produção em
25/08/2026 e são citados **arredondados para baixo** — número exato em anúncio envelhece e
vira mentira na semana seguinte.

**Ficou de fora, de propósito:**

- **"800+ escolas", "94% de retenção", "3,2x de crescimento"** e os logos Ambev, Petrobras,
  Embraer, Lilly, Novo Nordisk e Tupy, que estão em
  `components/landing/WiseWolfLanding.tsx` (linhas 25-32 e 154-158). A base real tem
  **6 tenants, nenhum pagante** e **uma** escola com operação de verdade. Além de falso, usar
  marca de terceiro sem autorização é risco de marca.
- **Depoimento de aluno** — não existe nenhum real no repositório.
- **Promessa de prazo** ("fale inglês em X meses") — não é mensurável, e é o tipo de
  promessa que CDC e CONAR tratam como enganosa.
- **Preço sem a carência.** O piso de R$ 169/mês exige plano de 12 meses, e o anúncio diz
  isso na mesma frase.

---

## Prova visual: painéis, não capturas

Os painéis do produto (`components/product/ProductPanels.tsx`) são desenhados no vídeo com
os **números reais da operação**, por dois motivos:

1. As capturas que existem no repositório vêm de ambiente de QA **vazio** — R$ 0,00 de
   faturamento, "BASEADO EM 1 ALUNOS ATIVOS", tarja "Diretor QA Responsivo" no topo, e
   overlay vermelho de acessibilidade por cima (`docs/qa/2026-07-24-role-responsive-audit/`).
   Uma delas, usada hoje no filme do Wolfie, é uma **tela de erro**.
2. Um PNG de 1440x900 encolhido para caber em 1080x1920 fica ilegível no celular. Em Reels,
   o que se lê é **um número grande**, não a tela inteira.

Os painéis usam a mesma estrutura, os mesmos rótulos e os mesmos números que o diretor vê.

> Se preferir capturas literais da tela, é possível: basta você entrar no sistema com dados
> reais e capturar as telas — aí elas entram como `{ file: ... }` no `evidence`, sem
> mudar mais nada.

---

## Fluxo

```bash
# 1. Locução de prévia (voz do macOS, grátis, marca d'água)
npx tsx remotion-ads/scripts/generate-preview-voice.ts

# 2. Revisar no Studio
npx remotion studio remotion-ads/index.ts --config=remotion-ads/remotion.config.ts

# 3. Renderizar
npx tsx remotion-ads/scripts/render-ads.ts                    # tudo
npx tsx remotion-ads/scripts/render-ads.ts aluno-intervalo    # um anúncio
ADS_FORMATS=reels npx tsx remotion-ads/scripts/render-ads.ts  # um formato

# 4. Masterizar o áudio para -16 LUFS (obrigatório antes de publicar)
npx tsx remotion-ads/scripts/master-audio.ts

# 5. Testes de zona segura
npx vitest run remotion-ads/meta/safeAreas.test.ts
```

Saída em `remotion-ads/out/<frente>/`, mais um `index.json` com o que é cada arquivo, para
qual posicionamento, com que ângulo, destino e as afirmações que ele sustenta.

### Por que a masterização é um passo à parte

O Remotion converte a locução mono em estéreo, e duplicar um canal soma ~3 LU na medição
integrada: a locução sai do gerador a -16,1 LUFS e o MP4 renderizado mede -12,9. Não é
clipe (true peak fica em -3,2 dBTP) — é desvio do alvo. `master-audio.ts` normaliza para
-16 LUFS / -1,5 dBTP **copiando o vídeo sem recodificar** (`-c:v copy`), então não há
segunda perda de imagem e o passo leva segundos por arquivo.

### Locução final

Enquanto a locução for a voz do macOS, o manifesto marca `commercialUseAllowed: false`, o
vídeo carrega a tarja **"PRÉVIA · locução local"** e os arquivos saem com sufixo `-previa`.
É a trava contra subir uma prévia para o gerenciador por engano.

Para a versão final, a chave da ElevenLabs já existe em `.env.video.local`
(`ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_VOICE_ID`). Regerar a locução e
substituir o manifesto remove a tarja e o sufixo.

---

## Antes de subir para o gerenciador

- [ ] Locução final gerada (sem a tarja de prévia)
- [ ] Conferir cada `claim` do `index.json` — são elas que sustentam o anúncio
- [ ] `/new-student` e `/new-saas` no ar e com o formulário funcionando
- [ ] **Não** mandar tráfego de professor para `/biblioteca` ou `/educador-ia`: em produção
      `hub_get_public_settings` devolve `catalogReady: false`, o botão de trial fica
      desabilitado ("Abertura em breve") e `create-hub-checkout` responde 503
      `HUB_CATALOG_NOT_READY`. Verba nessa página não tem ação possível do outro lado.
