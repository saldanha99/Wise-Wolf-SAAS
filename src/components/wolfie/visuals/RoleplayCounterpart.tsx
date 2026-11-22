import React from "react";
import { Mic, Target } from "lucide-react";

/**
 * Cena do roleplay da trilha da aula (22/11/2026): parece uma chamada de
 * trabalho, não um app infantil. O interlocutor é uma pessoa (vetor no código,
 * sem imagem gerada), com nome e cargo; o aluno aparece como miniatura com o
 * nível do microfone. Quem fala fica destacado.
 */
export interface RoleplayCast {
  /** Ex.: "Mark" */
  name: string;
  /** Ex.: "your manager" */
  role: string;
  objectives: string[];
}

export type RoleplaySpeaker = "counterpart" | "learner" | "idle";

/** "your manager Mark" → { name: "Mark", role: "your manager" } */
export function parseRoleplayCharacter(raw: string): { name: string; role: string } {
  const text = String(raw || "").replace(/^wolfie plays\s+/i, "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? "";
  if (/^[A-Z][a-z]+$/.test(last) && words.length > 1) {
    return { name: last, role: words.slice(0, -1).join(" ") };
  }
  return { name: text || "Your counterpart", role: "" };
}

// Retratos fictícios gerados pelo Codex (22/11/2026), WebP em public/.
const PORTRAITS = {
  gerente: { src: "/assets/wolfie/personagens/gerente.webp", gender: "m" },
  cliente: { src: "/assets/wolfie/personagens/cliente.webp", gender: "m" },
  recrutadora: { src: "/assets/wolfie/personagens/recrutadora.webp", gender: "f" },
  colega: { src: "/assets/wolfie/personagens/colega.webp", gender: "f" },
} as const;
type PortraitKey = keyof typeof PORTRAITS;

const FEMALE_NAMES = new Set([
  "sarah", "rachel", "kate", "emily", "jennifer", "karen", "linda", "susan", "ellen", "megan",
  "lauren", "alison", "rose", "grace", "claire", "amy", "lucy", "chloe", "olivia", "elizabeth",
  "ann", "anne", "jane", "helen", "michelle", "nicole", "kim", "beth", "sophie", "zoe",
]);

function nameGender(name: string): "f" | "m" | null {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[a-z]{2,}$/.test(first)) return null;
  if (FEMALE_NAMES.has(first) || /a$/.test(first)) return "f";
  return "m";
}

/** Foto pelo papel; se o nome indicar outro gênero, a foto do mesmo gênero. Sem papel conhecido: vetor. */
export function portraitFor(role: string, name: string): string | null {
  const text = `${role} ${name}`.toLowerCase();
  let key: PortraitKey | null = /manager|boss|lead|director|supervisor|head of|ceo|gerente|chefe/.test(text)
    ? "gerente"
    : /recruit|interview|hr\b|hiring|recrutador|entrevistador/.test(text)
    ? "recrutadora"
    : /client|customer|buyer|guest|cliente|investor/.test(text)
    ? "cliente"
    : /colleague|coworker|co-worker|teammate|partner|friend|peer|colega|developer|analyst/.test(text)
    ? "colega"
    : null;
  if (!key) return null;
  const gender = nameGender(name);
  if (gender && PORTRAITS[key].gender !== gender) {
    key = gender === "f"
      ? (key === "gerente" || key === "recrutadora" ? "recrutadora" : "colega")
      : (key === "recrutadora" || key === "gerente" ? "gerente" : "cliente");
  }
  return PORTRAITS[key].src;
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase() || "?";
}

interface Props {
  cast: RoleplayCast;
  speaker: RoleplaySpeaker;
  /** 0–1, nível do áudio do interlocutor */
  outputLevel: number;
  /** 0–1, nível do microfone do aluno */
  inputLevel: number;
}

export const RoleplayCounterpart: React.FC<Props> = ({ cast, speaker, outputLevel, inputLevel }) => {
  const [portraitFailed, setPortraitFailed] = React.useState(false);
  const portrait = portraitFailed ? null : portraitFor(cast.role, cast.name);
  const talking = speaker === "counterpart";
  const listening = speaker === "learner";
  const ring = talking ? 6 + Math.round(Math.min(1, outputLevel) * 18) : 0;
  return (
    <div className="relative mx-auto flex h-full w-full max-w-md flex-col items-center justify-center px-4 pt-6">
      {/* sala: luz de janela e linhas de mesa, só em CSS */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[2rem]">
        <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-sky-400/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-gradient-to-t from-slate-900/80 to-transparent" />
      </div>

      <div className="relative">
        <div
          className="rounded-full transition-[box-shadow] duration-150"
          style={{ boxShadow: talking ? `0 0 0 ${ring}px rgba(52, 211, 153, 0.22)` : "0 0 0 0 transparent" }}
        >
          {portrait
            ? (
              <img
                src={portrait}
                alt={`${cast.name}${cast.role ? `, ${cast.role}` : ""}`}
                width={192}
                height={192}
                className={`h-40 w-40 rounded-full border-2 object-cover sm:h-48 sm:w-48 ${talking ? "border-emerald-300" : "border-slate-700"}`}
                onError={() => setPortraitFailed(true)}
              />
            )
            : (
          <svg
            viewBox="0 0 160 160"
            className={`h-40 w-40 rounded-full border-2 sm:h-48 sm:w-48 ${talking ? "border-emerald-300" : "border-slate-700"}`}
            role="img"
            aria-label={`${cast.name}${cast.role ? `, ${cast.role}` : ""}`}
          >
            <defs>
              <linearGradient id="rp-bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#1e293b" />
                <stop offset="1" stopColor="#0f172a" />
              </linearGradient>
              <linearGradient id="rp-suit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#334155" />
                <stop offset="1" stopColor="#1e293b" />
              </linearGradient>
            </defs>
            <rect width="160" height="160" fill="url(#rp-bg)" />
            {/* ombros e paletó */}
            <path d="M22 160c4-34 28-52 58-52s54 18 58 52z" fill="url(#rp-suit)" />
            <path d="M68 110l12 22 12-22" fill="#e2e8f0" opacity="0.9" />
            <path d="M80 112v40" stroke="#0ea5e9" strokeWidth="5" strokeLinecap="round" />
            {/* rosto */}
            <circle cx="80" cy="70" r="30" fill="#c8a189" />
            <path d="M50 66c0-20 14-32 30-32s30 12 30 32c-6-10-16-15-30-15s-24 5-30 15z" fill="#3f3f46" />
            <text x="80" y="152" textAnchor="middle" fontSize="13" fontWeight="800" fill="#94a3b8">
              {initials(cast.name)}
            </text>
          </svg>
            )}
        </div>
        <span
          className={`absolute bottom-2 right-2 inline-flex h-4 w-4 rounded-full border-2 border-slate-950 ${
            talking ? "bg-emerald-400" : "bg-slate-500"
          }`}
          aria-hidden="true"
        />
      </div>

      <p className="mt-4 text-xl font-black tracking-tight text-white">{cast.name}</p>
      {cast.role ? <p className="text-sm font-semibold capitalize text-slate-400">{cast.role}</p> : null}
      <p
        className={`mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${
          talking
            ? "bg-emerald-400/15 text-emerald-200"
            : listening
            ? "bg-sky-400/15 text-sky-200"
            : "bg-slate-800 text-slate-400"
        }`}
        aria-live="polite"
      >
        <span className={`h-2 w-2 rounded-full ${talking ? "bg-emerald-400 animate-pulse" : listening ? "bg-sky-400 animate-pulse" : "bg-slate-500"}`} />
        {talking ? `${cast.name} está falando` : listening ? "Você está falando" : "Sua vez quando quiser"}
      </p>

      {/* miniatura do aluno, como numa chamada */}
      <div
        className={`absolute right-4 top-4 flex h-20 w-16 flex-col items-center justify-center rounded-xl border bg-slate-900/90 ${
          listening ? "border-sky-300" : "border-slate-700"
        }`}
        aria-hidden="true"
      >
        <Mic size={16} className={listening ? "text-sky-300" : "text-slate-500"} />
        <span className="mt-1 text-[10px] font-bold text-slate-300">Você</span>
        <span className="mt-1.5 h-1 w-10 overflow-hidden rounded-full bg-slate-800">
          <span
            className="block h-full rounded-full bg-sky-400 transition-[width] duration-100"
            style={{ width: `${Math.round(Math.min(1, inputLevel) * 100)}%` }}
          />
        </span>
      </div>

      {cast.objectives.length
        ? (
          <ol className="relative mt-5 w-full space-y-1.5" aria-label="Objetivos da conversa">
            {cast.objectives.slice(0, 3).map((objective, index) => (
              <li key={objective} className="flex gap-2 rounded-xl bg-slate-900/80 px-3 py-2 text-xs text-slate-200">
                <Target size={14} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
                <span><strong>{index + 1}.</strong> {objective}</span>
              </li>
            ))}
          </ol>
        )
        : null}
    </div>
  );
};

export default RoleplayCounterpart;
