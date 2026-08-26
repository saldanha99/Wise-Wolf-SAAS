# Vídeos do Wise Wolf Hub

A coleção contém cinco composições Remotion em português do Brasil:

- `HubOverviewPtBr`
- `HubLibraryPtBr`
- `HubEducadorIaPtBr`
- `HubWolfiePtBr`
- `HubSchoolOsPtBr`

Cada filme também possui uma composição vertical própria em `1080x1920`, com o sufixo `Story` (por exemplo, `HubOverviewPtBrStory`). Ela não é um recorte do master horizontal.

## Geração segura

Para revisar imediatamente no macOS sem usar uma chave externa, gere uma prévia local com uma voz instalada em português do Brasil:

```bash
npm run video:soundtrack
npm run video:voiceovers:preview-ptbr
npm run video:render:all
npm run video:validate -- --preview
npm run video:render:stories
npm run video:validate:stories -- --preview
```

Quando o manifesto ativo ainda aponta para uma locução comercial antiga, use `VIDEO_PREVIEW_ONLY=1` para revisar uma nova direção visual sem tocar nos masters públicos nem emitir receipts:

```bash
VIDEO_PREVIEW_ONLY=1 npm run video:render:all
VIDEO_PREVIEW_ONLY=1 npm run video:render:stories
```

A trilha, o whoosh de transição e o impacto da logo são sintetizados localmente por código determinístico, sem samples ou melodias de terceiros. A origem, a licença interna e os hashes ficam em `remotion/public/assets/hub/videos/sound/original-soundtrack.json` e entram no fingerprint da composição.

Renders de prévia são refeitos por padrão para que mudanças visuais ou sonoras nunca reutilizem um MP4 antigo. Use `VIDEO_REUSE_PREVIEW=1` somente quando quiser reaproveitar conscientemente uma prévia existente.

O gerador local usa `Luciana` por padrão e consulta `say -v '?'` antes de iniciar. `VIDEO_LOCAL_PTBR_VOICE` só é aceito quando corresponde exatamente a uma voz instalada com locale `pt_BR`; vozes `pt_PT`, como Joana, são recusadas. Áudio e legendas locais permanecem exclusivamente em `remotion/`, recebem marca d'água de prévia e nunca habilitam publicação comercial.

O gerador LiveCall com OpenAI/OpenRouter permanece disponível para compatibilidade com os masters já publicados:

```bash
npm run video:voiceovers:openai-livecall
npm run video:typecheck
npm run video:render:all
npm run video:validate -- --public
npm run video:render:stories
npm run video:validate:stories -- --public
```

O render comercial usa H.264 em CRF 18 e áudio AAC a 192 kbps. Depois aplica automaticamente `ffmpeg loudnorm` com alvo de `-16 LUFS`, true peak de `-1,5 dBTP` e teto validado de `-1 dBTP`. O vídeo permanece em stream copy; somente a faixa AAC é masterizada. Para atualizar com segurança masters comerciais já renderizados, sem refazer os quadros, use `npm run video:master:public`; o comando preserva duração, início das faixas e hash do fluxo visual, depois reemite receipts e manifesto pelo mecanismo comercial existente.

A VPS deve manter `OPENROUTER_API_KEY` somente no ambiente privado. A chave não é copiada para o Mac, não entra no pacote de áudio e nunca é gravada no repositório. Não configure `OPENAI_API_KEY` para este comando e nunca use prefixo `VITE_` em segredos de voz.

O gerador usa `POST https://openrouter.ai/api/v1/chat/completions` com streaming SSE, modalidades de texto e áudio e saída `pcm16` mono a 24 kHz. Cada cena recebe instruções rígidas para português do Brasil neutro, leitura literal e ausência de prosódia portuguesa, espanhola ou anglófona. O processo concatena `delta.audio.data`, captura `delta.audio.transcript`, normaliza espaços e Unicode e recusa a faixa se a transcrição não for exatamente igual ao roteiro. Não existe fallback para ElevenLabs nem para a voz do macOS.

Somente depois dessa validação a VPS embrulha o PCM16 em WAV e envia pacotes de até cinco cenas com hashes e `x-request-id`, `x-generation-id` ou o identificador da completion. O Mac valida a lista de arquivos, os hashes, a transcrição e o manifesto, converte cada WAV para MP3 com `ffmpeg` e salva imediatamente o bloco validado em cache. Assim, uma interrupção posterior não cobra nem regenera novamente as cenas já aprovadas. Os MP3 finais recebem nomes endereçados pelo SHA-256 do conteúdo e o manifesto completo é promovido por último, com escrita atômica; qualquer erro anterior mantém a coleção ativa apontando integralmente para os áudios anteriores.

`marin` é uma voz integrada da OpenAI dirigida por prompt, não uma voz comprovadamente brasileira nativa. O manifesto registra `voiceProvider=openai`, `voiceGateway=openrouter`, `voiceNative=false`, `voiceAccent=brazilian-prompted`, `voiceSourceAccent=openai-built-in` e `voiceLocaleValidation=openai_prompted_pt_br`. O vídeo mantém uma identificação discreta e permanente de voz gerada por IA. Esse fluxo legado não atende à política final premium de voz masculina brasileira nativa, take único e alinhamento real por palavra.

A chave da ElevenLabs deve existir somente em `.env.video.local`, arquivo já ignorado pelo Git. Nunca use prefixo `VITE_`, nunca grave a chave no código e nunca envie o arquivo de segredo ao repositório.
No editor, salve apenas `ELEVENLABS_API_KEY=<segredo>`, `ELEVENLABS_VOICE_ID=<id-aprovado>` e as opções privadas de voz que forem necessárias.

```bash
umask 077
$EDITOR .env.video.local
chmod 600 .env.video.local
npm run video:voiceovers
npm run video:audio:validate-final
npm run video:typecheck
npm run video:render:all
npm run video:validate -- --preview
```

`ELEVENLABS_VOICE_ID` é obrigatório. Escolha no Voice Library uma voz masculina profissional ou clonada, nativa em **Portuguese (Brazil)**, ou uma voz própria criada com amostras autorizadas de um falante brasileiro. O perfil precisa expor `gender=male`. Ouça a prévia antes de copiar o ID.

O gerador consulta os detalhes desse ID e só continua quando encontra evidência regional forte: `verified_languages` com locale `pt-BR`, ou uma voz profissional/clonada com labels simultâneas de idioma português e sotaque brasileiro. Voz genérica “Portuguese”, PT-PT, voz predefinida em inglês, voz sem evidência masculina e fallback automático são recusados. Os únicos modelos aceitos são `eleven_v3` e `eleven_multilingual_v2`; use o primeiro para uma entrega mais expressiva ou o segundo para máxima estabilidade narrativa.

A locução inteira de cada filme é enviada em uma única requisição. O gerador exige o alinhamento original por caractere devolvido pela ElevenLabs, recusa qualquer transcrição diferente do roteiro e deriva dele os tempos exatos de cada palavra, legenda e cena. Não existe estimativa por quantidade de caracteres nem concatenação de cinco falas. O manifesto registra `narrationTake=single_continuous`, `narrationRequestCount=1` e `captionTimingSource=provider_alignment`.

A exceção histórica `ELEVENLABS_ALLOW_MULTILINGUAL_PREMADE=1` continua reconhecida pelo validador regional para auditoria de materiais antigos, mas o gerador final exige `voiceNative=true` e, portanto, não publica uma voz americana como nativa. Para `eleven_multilingual_v2`, a regulagem auditada usa estabilidade `0.38`, similaridade `0.78`, estilo `0.34`, reforço de speaker e velocidade `0.98`.

## Licença e publicação

Para ElevenLabs, o pipeline consulta o plano ativo antes de gerar. Em plano sem direito comercial, a locução é marcada como prévia não comercial e os vídeos ficam somente em `remotion/previews/`.

Para OpenAI via OpenRouter, o pipeline exige `commercialLicenseBasis=openrouter_terms`, o hash das instruções PT-BR, um identificador real da requisição, a voz `marin`, o modelo `openai/gpt-audio`, o gateway `openrouter` e a identificação de conteúdo gerado por IA gravada no vídeo. Evidências de assinatura da ElevenLabs ou de uso direto da OpenAI não podem liberar essa faixa, e vice-versa.

Somente quando todas as locuções estiverem marcadas com `commercialUseAllowed: true`, os renders são enviados para `public/assets/hub/videos/`. A aplicação também exige `VITE_HUB_PUBLIC_VIDEOS=true`; sem essa configuração, os heróis mantêm os mockups estáticos.

Os masters verticais usam um pacote isolado em `public/assets/hub/videos/social/`, com manifesto, pôsteres, legendas e receipts próprios. A publicação 9:16 exige `VITE_HUB_PUBLIC_STORY_VIDEOS=true`; com a configuração desativada, qualquer MP4, pôster, receipt ou manifesto Story presente bloqueia o build para evitar uma entrega parcial ou sem proveniência.

O cache público é fail-closed. Um pacote só é reutilizado quando `receipts/<slug>.json` comprova, por SHA-256, o roteiro, a locução, os dados de entrada, as fontes da composição, a versão instalada do Remotion, a voz, a licença comercial e cada artefato entregue. Receipts comerciais são gravados de forma atômica depois que vídeo, pôster e legenda terminam; arquivo ausente, legado ou divergente força um novo render. O JSON público é sanitizado: expõe apenas slug, data, idioma, composição, autorização comercial e fingerprints, nunca request ID, plano da conta ou credenciais.

A validação sempre exige um destino explícito:

```bash
npm run video:validate -- --preview
npm run video:validate -- --public
npm run video:validate:stories -- --preview
npm run video:validate:stories -- --public
```

O modo `--preview` não exige licença nem receipt. O modo `--public` falha se qualquer locução não tiver evidência comercial, data de geração e request ID do provedor, ou se um receipt/artefato não corresponder ao fingerprint atual.

Para a entrega premium definitiva, a política estrita já vem ativada. Ela bloqueia qualquer novo receipt ou master público que não use ElevenLabs, voz masculina brasileira nativa, take único e alinhamento real:

```bash
npm run video:audio:validate-final
npm run video:render:all
npm run video:validate -- --public
```

A emissão e a validação do receipt recusam OpenAI/LiveCall, voz não nativa, voz sem evidência masculina, take segmentado, mais de uma requisição, legenda estimada ou legenda sem timestamps reais por palavra. `VIDEO_FINAL_AUDIO_STRICT=0` existe apenas para auditoria consciente de um pacote legado; nunca deve ser usado para publicar a coleção nova. Os masters já existentes continuam servidos pelo build, mas não podem ser recriados silenciosamente pelo pipeline premium.

Antes de ativar a configuração pública:

1. confirme a base comercial do provedor e da voz;
2. regenere as cinco locuções com a chave restrita do provedor aprovado;
3. renderize a coleção com `npm run video:render:all`;
4. valide obrigatoriamente com `npm run video:validate -- --public`;
5. renderize e valide o formato vertical com `npm run video:render:stories` e `npm run video:validate:stories -- --public`;
6. verifique desktop, mobile, legendas e reprodução por teclado;
7. publique os binários no armazenamento definitivo e confira os caminhos dos dois manifestos.

Locuções comerciais antigas que não tenham `generatedAt` e `requestId` no manifesto não são aceitas como evidência de licença. Regenere-as no plano pago em vez de preencher esses campos manualmente.
