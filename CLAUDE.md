# Wise Wolf SAAS — CLAUDE.md

Guia técnico para o Claude Code neste projeto.

---

## Stack do Projeto

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Supabase (Postgres + Edge Functions em Deno)
- **IA:** Gemini (wolfie-brain), Google Translate TTS (wolfie-tts)
- **Pagamentos:** Asaas
- **Deploy:** Vercel (frontend) + Supabase (edge functions)

---

## Wolfie AI Tutor — Arquitetura de Áudio ✅ FUNCIONANDO

> **Leia isto ANTES de qualquer alteração em `WolfieTutor.tsx` ou `wolfie-tts`.**  
> Levou semanas para descobrir e estabilizar. Não quebre o que funciona.

### Stack de Áudio

| Camada | Desktop | iOS Safari/Chrome |
|--------|---------|-------------------|
| TTS (geração) | `wolfie-tts` → Google Translate TTS | idem |
| Playback principal | `AudioContext` + `BufferSource` | `HTMLAudioElement` pré-ativado |
| Fallback 1 | `HTMLAudioElement` (blob URL) | `AudioContext` (se preUnlocked falhar) |
| Fallback 2 | `Web Speech API` | `speakWebSpeech` |

---

### Edge Function: `wolfie-tts`

**Localização:** `supabase/functions/wolfie-tts/index.ts`  
**TTS em uso:** Google Translate TTS (v9, funcional)

```
GET https://translate.google.com/translate_tts
  ?ie=UTF-8
  &q=TEXTO_ENCODED
  &tl=en-US          ← locale extraído do nome da voz
  &client=gtx
  &ttsspeed=1
```

**Regras críticas:**
- ✅ **User-Agent de browser real obrigatório** — Google bloqueia UAs de servidor/bot
- ✅ **Chunks de 180 chars** — limite do endpoint; textos longos são divididos em sentenças
- ✅ **Chunks buscados em paralelo** com `Promise.all` e concatenados
- ✅ **Locale** extraído do nome da voz: `en-US-JennyNeural` → `en-US`, `pt-BR-ThalitaNeural` → `pt-BR`

**O que NÃO funciona no Deno/Supabase Edge Functions:**
- ❌ **Microsoft Edge TTS (WebSocket)** — WebSocket conecta, mas mensagens binárias nunca chegam. Tentamos 7 versões com `binaryType`, subprotocolos, ConnectionId — nada funcionou.
- ❌ **Streamelements TTS** — era free, agora retorna 401 (exige auth)
- ❌ Qualquer WebSocket para TTS — o runtime Deno do Supabase tem problemas com binary frames externos

---

### iOS Safari/Chrome — Regras de Ouro

**Problema:** iOS bloqueia `audio.play()` e `speechSynthesis.speak()` em callbacks assíncronos. O fetch do wolfie-tts leva 2-5s → o callback está fora do contexto de gesto → iOS bloqueia silenciosamente.

#### Detecção de iOS
```typescript
// Módulo-level (fora do componente)
const IS_IOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);
```

#### `unlockAudio()` — DEVE ser chamado no `onTouchStart`
```typescript
// Três camadas de unlock, todas necessárias:

// 1. AudioContext: cria + resume + toca 1 sample silencioso
const ctx = new AudioContext();
ctx.resume().then(() => {
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start(0);
});

// 2. Web Speech API unlock (para o fallback)
const u = new SpeechSynthesisUtterance('');
window.speechSynthesis.speak(u);
window.speechSynthesis.cancel();

// 3. HTMLAudioElement pré-ativado — CRÍTICO: src vazio NÃO funciona no iOS!
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const audio = new Audio(SILENT_WAV); // src válido obrigatório
audio.volume = 0;
audio.play().then(() => audio.pause()); // ativa o elemento
preUnlockedAudioRef.current = audio;    // guarda para uso no callback async
```

#### `startIOSKeepAlive()` — inicia no `onTouchStart`, para ao receber áudio
```typescript
// iOS suspende AudioContext após ~1-2s de inatividade.
// O fetch leva 2-5s → contexto suspende antes de decodeAudioData.
// Solução: toca 1 sample silencioso a cada 500ms.
setInterval(() => {
  if (ctx.state !== 'running') return;
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start(0);
}, 500);
```

#### Playback no iOS — ordem de tentativa em `speak()`
```
1. preUnlockedAudioRef + blob URL  ← mais confiável (elemento já ativado no toque)
2. preUnlockedAudioRef + data URI  ← fallback sem blob URL
3. AudioContext.decodeAudioData    ← funciona se keepalive manteve ctx running
4. speakWebSpeech()                ← último recurso (qualidade baixa + limitado em async)
```

#### Regras de onde chamar o unlock
```typescript
onTouchStart → startRecording() → unlockAudio() + startIOSKeepAlive()
onTouchEnd   → stopRecordingAndSend() → unlockAudio() (re-unlock mais próximo do speak)
onClick texto → sendMessage() → unlockAudio()
```

---

### Desktop (Chrome/Firefox/Edge)

**Sem restrições de gesture.** Fluxo simples:
1. `AudioContext.decodeAudioData(bytes)` → `BufferSource.start(0)` ← preferido (qualidade, sem lag)
2. `HTMLAudioElement` + blob URL ← fallback
3. `Web Speech API` ← último recurso

---

### Arquivos Relevantes

| Arquivo | Responsabilidade |
|---------|-----------------|
| `components/WolfieTutor.tsx` | Unlock, keepalive, playback iOS/Desktop, estado da conversa |
| `supabase/functions/wolfie-tts/index.ts` | Geração TTS → Google Translate → base64 MP3 |
| `supabase/functions/wolfie-brain/index.ts` | IA conversacional (Gemini) — NÃO mexer no TTS |

### Variáveis de Ambiente (Supabase)
- `wolfie-brain`: precisa de `GEMINI_API_KEY` (configurada no painel Supabase)
- `wolfie-tts`: **sem variáveis** — Google Translate TTS é gratuito e sem auth

---

## Convenções do Projeto

- TypeScript estrito (sem `any`)
- Comentários em português
- Deploy automático via Vercel (push para `main`)
- Edge functions: deploy manual via `supabase functions deploy` ou MCP Supabase
- **Dados sensíveis da Wise Wolf** (CNPJ, email, telefone, endereço) **NUNCA no código** — apenas em variáveis de ambiente ou formulários preenchidos pelo usuário
