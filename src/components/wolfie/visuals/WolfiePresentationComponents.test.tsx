import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WolfieCaptionBar } from "./WolfieCaptionBar";
import {
  DEFAULT_WOLFIE_CHARACTER_IMAGE,
  DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE,
  WolfieCharacter,
} from "./WolfieCharacter";
import { WolfieScenarioStage } from "./WolfieScenarioStage";
import { WolfieSessionHUD } from "./WolfieSessionHUD";
import type { WolfieVisualSceneProfile } from "./types";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const profile: WolfieVisualSceneProfile = {
  version: 1,
  key: "experience:meetings-business",
  experienceId: "meetings-business",
  universeId: "global-meetings",
  experienceMode: "global_meeting",
  layout: "meeting",
  environmentId: "international-boardroom",
  environmentDescription: "Boardroom internacional",
  castIds: ["wolfie-coach", "executive-counterpart"],
  camera: "wide",
  characterSide: "left",
  palette: {
    accent: "#38bdf8",
    glow: "rgba(56,189,248,.32)",
    scrim: "linear-gradient(90deg, rgba(2,6,23,.24), rgba(2,6,23,.82))",
    gradient: "linear-gradient(135deg, #0f172a, #172554)",
  },
  assets: {
    desktopAvif: "/scene/desktop.avif",
    desktopWebp: "/scene/desktop.webp",
    mobileAvif: "/scene/mobile.avif",
    mobileWebp: "/scene/mobile.webp",
    posterWebp: "/scene/poster.webp",
  },
  hudVariant: "meeting",
  accessibleEnvironmentLabel:
    "Sala de reunião internacional para treinamento de negócios",
};

describe("WolfieScenarioStage", () => {
  it("keeps semantic slots interactive while visual layers ignore pointers", () => {
    const onAction = vi.fn();
    const { container } = render(
      <WolfieScenarioStage
        profile={profile}
        reducedMotion
        priority
        hud={<p>HUD da sessão</p>}
        character={<div>Personagem</div>}
        context={<p>Decisão pendente</p>}
        caption={<p>Legenda</p>}
        actions={<button onClick={onAction}>Responder</button>}
        modal={<div role="dialog">Confirmação</div>}
      />,
    );

    const stage = screen.getByRole("region", {
      name: profile.accessibleEnvironmentLabel,
    });
    expect(stage).toHaveAttribute("data-motion", "static");
    expect(stage).toHaveAttribute("data-background-status", "image");
    expect(container.querySelector("[data-stage-layer='character']"))
      .toHaveClass("pointer-events-none");
    expect(screen.getByRole("complementary", { name: "Contexto da prática" }))
      .toHaveClass("pointer-events-auto");
    expect(screen.getByRole("group", { name: "Ações da prática" }))
      .toHaveClass("pointer-events-auto");
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");

    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("falls back to the palette when the active background fails", () => {
    const onBackgroundError = vi.fn();
    const { container } = render(
      <WolfieScenarioStage
        profile={profile}
        onBackgroundError={onBackgroundError}
      />,
    );
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);

    expect(screen.getByRole("region", {
      name: profile.accessibleEnvironmentLabel,
    })).toHaveAttribute("data-background-status", "fallback");
    expect(container.querySelector("picture")).not.toBeInTheDocument();
    expect(onBackgroundError).toHaveBeenCalledWith("/scene/desktop.webp");
  });

  it("keeps the environment vivid and marks the ambient background layer", () => {
    const { container } = render(
      <WolfieScenarioStage profile={profile} reducedMotion={false} />,
    );
    const background = container.querySelector(
      "[data-stage-layer='background']",
    );
    const scrim = container.querySelector("[data-stage-layer='scrim']");

    expect(background).toHaveStyle({
      filter: "brightness(1.06) saturate(1.08)",
    });
    expect(scrim).toHaveStyle({ background: profile.palette.scrim });
  });

  it("does not request an image when the profile has no asset manifest", () => {
    const paletteOnlyProfile: WolfieVisualSceneProfile = {
      ...profile,
      key: "fallback:neutral",
      assets: undefined,
    };
    const { container } = render(
      <WolfieScenarioStage profile={paletteOnlyProfile} />,
    );

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("region", {
      name: paletteOnlyProfile.accessibleEnvironmentLabel,
    })).toHaveAttribute("data-background-status", "fallback");
  });
});

describe("WolfieCharacter", () => {
  it("uses the approved pilot, clamps audio energy and supports static mode", () => {
    const { container } = render(
      <WolfieCharacter
        profile={profile}
        state="SPEAKING"
        inputLevel={0.7}
        outputLevel={4}
        reducedMotion
      />,
    );
    const character = container.querySelector("[data-character-state]");
    expect(character).toHaveClass("pointer-events-none");
    expect(character).toHaveAttribute("data-output-level", "1.000");
    expect(character).toHaveAttribute("data-input-level", "0.000");
    expect(character).toHaveAttribute("data-motion", "static");
    expect(character).toHaveAttribute("data-lip-sync", "off");
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      DEFAULT_WOLFIE_CHARACTER_IMAGE,
    );
  });

  it("tries the legacy fallback and then shows a functional symbol", () => {
    const onImageError = vi.fn();
    const { container } = render(
      <WolfieCharacter
        profile={profile}
        imageSrc="/characters/new.webp"
        fallbackImageSrc="/characters/legacy.webp"
        onImageError={onImageError}
      />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/characters/legacy.webp",
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("[data-character-fallback='symbol']"))
      .toBeInTheDocument();
    expect(onImageError.mock.calls.map(([source]) => source)).toEqual([
      "/characters/new.webp",
      "/characters/legacy.webp",
    ]);
  });

  it("drives the speaking mouth from measured output audio", () => {
    const { container } = render(
      <WolfieCharacter
        profile={profile}
        state="SPEAKING"
        outputLevel={0.1}
        reducedMotion={false}
      />,
    );
    const character = container.querySelector("[data-character-state]");
    const mouth = container.querySelector("[data-character-layer='mouth']");

    expect(character).toHaveAttribute("data-lip-sync", "audio");
    expect(character).toHaveAttribute("data-mouth-openness", "0.520");
    expect(mouth).toHaveAttribute("src", DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE);
  });

  it("uses a bounded speech fallback when an audio meter is unavailable", () => {
    const { container } = render(
      <WolfieCharacter
        profile={profile}
        state="SPEAKING"
        outputLevel={0}
        reducedMotion={false}
      />,
    );

    expect(container.querySelector("[data-character-state]"))
      .toHaveAttribute("data-lip-sync", "fallback");
    expect(container.querySelector("[data-character-layer='mouth']"))
      .toBeInTheDocument();
  });

  it("can expose an equivalent accessible label when it is not decorative", () => {
    render(
      <WolfieCharacter
        profile={profile}
        state="LISTENING"
        decorative={false}
        accessibleLabel="Alex, interlocutor virtual"
        reducedMotion
      />,
    );
    expect(screen.getByRole("img", {
      name: "Alex, interlocutor virtual: ouvindo.",
    })).toBeInTheDocument();
  });
});

describe("WolfieSessionHUD", () => {
  it("shows status in text and keeps its controls operable", () => {
    const onClose = vi.fn();
    const onPause = vi.fn();
    render(
      <WolfieSessionHUD
        profile={profile}
        state="LISTENING"
        elapsedSeconds={65}
        level="B2"
        topic="Negociar a aprovação de um piloto"
        stageLabel="Simulação"
        modeLabel="Ao vivo"
        connectionLabel="Conectado"
        controls={<button onClick={onPause}>Pausar</button>}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Ouvindo")).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo de sessão 01:05"))
      .toBeInTheDocument();
    expect(screen.getByText("B2")).toBeInTheDocument();
    expect(screen.getByText("Negociar a aprovação de um piloto"))
      .toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Controles da sessão" }))
      .toHaveClass("pointer-events-auto");

    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar Wolfie Tutor" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("WolfieCaptionBar", () => {
  it("does not announce partial tokens and announces an opted-in final caption", () => {
    const { rerender } = render(
      <WolfieCaptionBar
        text="We should"
        speaker="Executive counterpart"
        language="en"
        state="SPEAKING"
        isFinal={false}
        announceFinal
      />,
    );
    expect(screen.getByText("We should")).toHaveAttribute("aria-live", "off");
    expect(screen.getByText("We should")).toHaveAttribute("lang", "en");

    rerender(
      <WolfieCaptionBar
        text="We should approve the pilot."
        speaker="Executive counterpart"
        language="en"
        state="SPEAKING"
        isFinal
        announceFinal
      />,
    );
    expect(screen.getByText("We should approve the pilot."))
      .toHaveAttribute("aria-live", "polite");
  });

  it("keeps caption actions in an accessible interactive slot", () => {
    const onReplay = vi.fn();
    render(
      <WolfieCaptionBar
        state="IDLE"
        actions={<button onClick={onReplay}>Ouvir novamente</button>}
      />,
    );

    expect(screen.getByText("Pronto para conversar")).toHaveAttribute(
      "lang",
      "pt-BR",
    );
    expect(screen.getByRole("group", { name: "Ações da legenda" }))
      .toHaveClass("pointer-events-auto");
    fireEvent.click(screen.getByRole("button", { name: "Ouvir novamente" }));
    expect(onReplay).toHaveBeenCalledOnce();
  });
});
