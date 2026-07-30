import React, { useEffect, useState } from "react";
import {
  WolfieAvatar,
  type WolfieAvatarState,
} from "./WolfieAvatar";

const STATES: WolfieAvatarState[] = [
  "IDLE",
  "LISTENING",
  "THINKING",
  "SYNTHESIZING",
  "SPEAKING",
  "INTERRUPTED",
  "ERROR",
];

/**
 * Bancada visual isolada. Não participa do fluxo de produção.
 * Em LISTENING/SPEAKING, o oscilador simula o nível que viria de um
 * AnalyserNode para permitir validar o movimento sem microfone.
 */
export const WolfieAvatarDemo: React.FC = () => {
  const [state, setState] = useState<WolfieAvatarState>("IDLE");
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [simulateAudio, setSimulateAudio] = useState(true);

  useEffect(() => {
    if (!simulateAudio || (state !== "LISTENING" && state !== "SPEAKING")) {
      if (state !== "LISTENING") setInputLevel(0);
      if (state !== "SPEAKING") setOutputLevel(0);
      return;
    }

    let frame = 0;
    const startedAt = performance.now();
    const update = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      const carrier = Math.abs(Math.sin(elapsed * 8.7));
      const syllables = Math.abs(Math.sin(elapsed * 3.1 + 0.8));
      const level = Math.min(1, 0.04 + carrier * syllables * 0.88);
      if (state === "LISTENING") setInputLevel(level);
      if (state === "SPEAKING") setOutputLevel(level);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [simulateAudio, state]);

  return (
    <section className="mx-auto grid w-full max-w-5xl gap-6 rounded-3xl bg-slate-950 p-6 text-white md:grid-cols-[minmax(280px,420px)_1fr]">
      <WolfieAvatar
        state={state}
        inputLevel={inputLevel}
        outputLevel={outputLevel}
        showStatus
        className="w-full"
      />

      <div className="flex flex-col justify-center gap-5">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-300">
            Bancada do mascote
          </p>
          <h2 className="mt-2 text-2xl font-black">Estados e níveis de áudio</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            A boca só abre quando SPEAKING recebe outputLevel. LISTENING usa
            inputLevel apenas para a reação de escuta.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {STATES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setState(option)}
              aria-pressed={state === option}
              className={`rounded-full border px-3 py-2 text-[10px] font-black tracking-wider transition ${
                state === option
                  ? "border-cyan-300 bg-cyan-400/20 text-cyan-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={simulateAudio}
            onChange={(event) => setSimulateAudio(event.target.checked)}
            className="h-4 w-4 accent-cyan-400"
          />
          Simular energia do áudio
        </label>

        <label className="grid gap-2 text-xs font-semibold text-slate-300">
          Entrada do microfone: {inputLevel.toFixed(2)}
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={inputLevel}
            disabled={simulateAudio}
            onChange={(event) => setInputLevel(Number(event.target.value))}
            className="accent-rose-400 disabled:opacity-40"
          />
        </label>

        <label className="grid gap-2 text-xs font-semibold text-slate-300">
          Saída da voz: {outputLevel.toFixed(2)}
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={outputLevel}
            disabled={simulateAudio}
            onChange={(event) => setOutputLevel(Number(event.target.value))}
            className="accent-cyan-400 disabled:opacity-40"
          />
        </label>
      </div>
    </section>
  );
};

export default WolfieAvatarDemo;
