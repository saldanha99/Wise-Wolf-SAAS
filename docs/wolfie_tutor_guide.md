# 🐺 Wolfie Tutor: Guia de Lógica e Funcionamento

O **Wolfie Tutor** é um assistente de conversação inteligente integrado ao Ecossistema Wise Wolf. Ele foi projetado para simular interações reais em inglês, oferecendo feedback pedagógico instantâneo e uma interface imersiva.

---

## 1. Modos de Operação

O Wolfie suporta três níveis de interação, adaptando-se à necessidade do aluno:

| Modo | Lógica de Gatilho | Interface | Ideal para... |
| :--- | :--- | :--- | :--- |
| **Chat de Texto** | Input de texto manual | Chat bolha convencional | Treinar escrita e leitura |
| **Voz (Mãos Dadas)** | Push-to-Talk (Segurar Orb) | Esfera central reativa | Treino focado e controlado |
| **Live Call ⚡** | VAD (Detecção Automática) | Imersão Holográfica | Fluidez e conversação real |

---

## 2. Lógica Core (Frontend)

O sistema reside principalmente no componente `WolfieTutor.tsx` e utiliza uma máquina de estados para gerenciar a conversa.

### Máquina de Estados (CallState)
- **IDLE**: Aguardando iniciativa do aluno.
- **LISTENING**: Capturando áudio via microfone.
- **THINKING**: Processando áudio/texto no servidor (Gemini/OpenAI).
- **SPEAKING**: Reproduzindo a resposta do tutor via TTS.

### VAD - Voice Activity Detection (Modo Live Call)
A detecção de voz é processada localmente para garantir baixa latência:
- **Início**: Se o volume do microfone excede o threshold por >400ms, a gravação inicia.
- **Fim (Auto-Submit)**: Se houver silêncio (>threshold) por >1500ms, o áudio é enviado automaticamente.
- **Interrupção**: Se o aluno começa a falar enquanto o tutor está no estado `SPEAKING` por >300ms, o tutor cancela a fala imediatamente e entra em modo de escuta.

---

## 3. Orquestração de IA (Backend)

O Wolfie utiliza a Supabase Edge Function `wolfie-brain` como seu sistema nervoso central.

### Fluxo de Agentes Internos
1. **Tradução**: Gera uma tradução contextualmente correta para o português.
2. **Correção**: Analisa o erro do aluno (Gramática/Vocabulário) e sugere a forma correta.
3. **Vocabulário**: Identifica termos-chave da conversa e fornece definições e exemplos.
4. **Responde**: Gera a resposta em inglês mantendo a personalidade do Wolfie.
5. **Quiz**: Ocasionalmente gera um mini-quiz baseado no que foi conversado.

---

## 4. Visual Engine (VoicePoweredOrb)

A interface utiliza **WebGL (via OGL)** para renderizar um "Orb" holográfico reativo.

- **Frequência de Áudio**: O Orb recebe o `MediaStream` e utiliza um `AnalyserNode` para mapear frequências de áudio em distorções geométricas.
- **Uniforms Dinâmicos**: O shader do Orb muda de cor e velocidade de rotação com base no estado da conversa:
    - **Vermelho/Rápido**: Ouvindo (LISTENING).
    - **Roxo/Pulsante**: Pensando (THINKING).
    - **Ciano/Ondulado**: Falando (SPEAKING).

---

## 5. Configurações Pedagógicas

### TTS Adaptativo
A velocidade da fala do tutor é ajustada automaticamente de acordo com o nível do aluno (Student Level):
- **A1/A2**: 0.80x - 0.85x (Mais devagar).
- **B1/B2**: 0.90x - 0.95x (Natural).
- **C1/C2**: 1.0x (Nativa/Rápida).

### Contexto e Tópicos
O Wolfie pode ser iniciado com um `topic` específico (Ex: "Job Interview", "Travel"). Isso injeta diretrizes no sistema de prompt para que a IA mantenha o foco pedagógico desejado.

---

## 6. Fluxo de Dados (Step-by-Step)

1.  **Captura**: Aluno fala -> `MediaRecorder` captura em blocos de 100ms.
2.  **Envio**: Áudio é convertido para `Base64` e enviado ao `wolfie-brain`.
3.  **Processamento**: 
    - Transcrição (Whisper).
    - Inteligência (Gemini 1.5 Pro).
    - Agentes de correção e vocabulário.
4.  **Resposta**: JSON com texto da resposta + metadados (correções, quiz).
5.  **Output**: `SpeechSynthesis` (TTS) converte texto em voz no navegador enquanto a interface visualiza a fala no Orb.

---

> [!IMPORTANT]
> O Wolfie Tutor prioriza a **privacidade**. O microfone só é ativado após a permissão do navegador e os estados de "Ouvindo" são claramente indicados visualmente.
