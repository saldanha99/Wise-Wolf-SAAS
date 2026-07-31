/// <reference lib="deno.ns" />

import {
  ALL_EXPERIENCES,
  experienceSupportsAudience,
  getExperienceById,
  getUniverseForExperience,
  LEARNING_UNIVERSE_IDS,
  LEARNING_UNIVERSES,
  pickAudienceCompatibleExperience,
  recommendExperiences,
} from "../../src/components/wolfie/experienceCatalog.ts";
import {
  type ActivitySubject,
  parseExperienceContext,
} from "../../supabase/functions/wolfie-activity/personalization.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    message ?? `expected ${expectedJson}, received ${actualJson}`,
  );
}

function assertUnique(values: string[], label: string) {
  const duplicates = values.filter((value, index) =>
    values.indexOf(value) !== index
  );
  assertEquals(
    [...new Set(duplicates)].sort(),
    [],
    `${label} duplicados: ${[...new Set(duplicates)].sort().join(", ")}`,
  );
}

Deno.test("o catálogo contém exatamente os nove universos Wolfie", () => {
  const expectedUniverseIds = [
    "about-you",
    "career",
    "daily-life",
    "events",
    "global-meetings",
    "international-exams",
    "kids-teens",
    "skill-labs",
    "speaking",
  ];

  assertEquals(LEARNING_UNIVERSES.length, 9);
  assertEquals(
    [...LEARNING_UNIVERSE_IDS].sort(),
    expectedUniverseIds,
  );
  assertEquals(
    LEARNING_UNIVERSES.map((universe) => universe.id).sort(),
    expectedUniverseIds,
  );
  assertUnique(
    LEARNING_UNIVERSES.map((universe) => universe.id),
    "IDs de universo",
  );
});

Deno.test("universos não estão vazios e IDs de experiências são únicos", () => {
  LEARNING_UNIVERSES.forEach((universe) => {
    assert(
      universe.items.length > 0,
      `o universo ${universe.id} não pode ficar vazio`,
    );
  });

  assertUnique(
    ALL_EXPERIENCES.map((item) => item.id),
    "IDs de experiência",
  );
  assertEquals(
    ALL_EXPERIENCES.length,
    LEARNING_UNIVERSES.reduce(
      (total, universe) => total + universe.items.length,
      0,
    ),
  );
});

Deno.test("toda experiência resolve para ela mesma e para seu universo", () => {
  LEARNING_UNIVERSES.forEach((universe) => {
    universe.items.forEach((item) => {
      assertEquals(
        getExperienceById(item.id)?.id,
        item.id,
        `getExperienceById não resolveu ${item.id}`,
      );
      assertEquals(
        getUniverseForExperience(item.id)?.id,
        universe.id,
        `${item.id} resolveu para o universo incorreto`,
      );
    });
  });
});

Deno.test("toda experiência do catálogo é aceita pelo contrato do backend", () => {
  LEARNING_UNIVERSES.forEach((universe) => {
    universe.items.forEach((item) => {
      const parsed = parseExperienceContext(
        {
          id: item.id,
          title: item.title,
          description: item.description,
          universeId: universe.id,
          experienceMode: item.experienceMode,
          audiences: item.audiences,
          realWorldGoal: item.realWorldGoal,
        },
        item.subject as ActivitySubject,
        item.sector,
      );
      assertEquals(
        parsed?.id,
        item.id,
        `${item.id} foi recusada pelo contrato do backend`,
      );
    });
  });
});

Deno.test("o universo Kids usa apenas missões infantis/adolescentes e públicos seguros", () => {
  const kidsUniverse = LEARNING_UNIVERSES.find((universe) =>
    universe.id === "kids-teens"
  );
  assert(kidsUniverse, "universo kids-teens ausente");

  kidsUniverse.items.forEach((item) => {
    assert(
      item.experienceMode === "child_mission" ||
        item.experienceMode === "teen_challenge",
      `${item.id} usa modo incompatível com Kids: ${item.experienceMode}`,
    );
    assert(
      item.audiences.length > 0 &&
        item.audiences.every((audience) =>
          audience === "kids" || audience === "teens"
        ),
      `${item.id} expõe público incompatível com Kids: ${
        item.audiences.join(", ")
      }`,
    );
    assert(
      item.subject !== "global_meetings",
      `${item.id} não pode herdar o assunto reuniões globais`,
    );
  });
});

Deno.test("experiências de reuniões globais mantêm assunto, modo, setor e público coerentes", () => {
  const meetingsUniverse = LEARNING_UNIVERSES.find((universe) =>
    universe.id === "global-meetings"
  );
  assert(meetingsUniverse, "universo global-meetings ausente");

  meetingsUniverse.items.forEach((item) => {
    assertEquals(
      item.subject,
      "global_meetings",
      `${item.id} usa assunto incompatível`,
    );
    assert(
      item.experienceMode === "global_meeting" ||
        item.experienceMode === "presentation",
      `${item.id} usa modo incompatível: ${item.experienceMode}`,
    );
    assert(item.sector?.trim(), `${item.id} precisa declarar um setor`);
    assert(
      item.audiences.length > 0 &&
        item.audiences.every((audience) =>
          audience === "adult" || audience === "professional"
        ),
      `${item.id} expõe reuniões globais a público incompatível`,
    );
    assert(
      item.skills.includes("presentation"),
      `${item.id} precisa treinar presentation`,
    );
  });

  ALL_EXPERIENCES
    .filter((item) => item.experienceMode === "global_meeting")
    .forEach((item) => {
      assertEquals(
        item.subject,
        "global_meetings",
        `${item.id} usa global_meeting fora do assunto correspondente`,
      );
    });
});

Deno.test("recomendações Kids nunca incluem experiências profissionais", () => {
  const generalAdultExperience = getExperienceById("introduce-yourself");
  assert(generalAdultExperience);
  assert(
    !experienceSupportsAudience(generalAdultExperience, "kids"),
    "audience=all não pode tornar uma experiência adulta elegível para Kids",
  );
  const hostileProfessionalContexts = [
    {
      role: "CEO de uma multinacional",
      goal: "liderar uma reunião global sobre hotel expansion",
      interests: "clientes, vendas, prazos e resultados trimestrais",
    },
    {
      role: "Gerente de logística",
      goal: "negociar com fornecedores internacionais",
      interests: ["global meetings", "presentation", "leadership"],
    },
    {
      role: "Médica executiva",
      goal: "apresentar resultados em congresso e reunião corporativa",
      interests: "research networking promotion",
    },
  ];

  hostileProfessionalContexts.forEach((profile) => {
    const recommendations = recommendExperiences(
      { ...profile, audience: "kids" },
      ALL_EXPERIENCES.length,
    );

    assert(recommendations.length > 0, "Kids deve receber recomendações");
    recommendations.forEach((item) => {
      const universeId = getUniverseForExperience(item.id)?.id;
      assert(
        !item.audiences.includes("professional"),
        `recomendação Kids vazou experiência profissional: ${item.id}`,
      );
      assert(
        universeId === "kids-teens",
        `recomendação Kids saiu do universo kids-teens para ${universeId}: ${item.id}`,
      );
    });
  });
});

Deno.test("fallback de retomada nunca sai do público atual", () => {
  const adultSubjectFallback = getExperienceById("give-your-opinion");
  const kidsRecommendation = getExperienceById("school-life");
  assert(adultSubjectFallback);
  assert(kidsRecommendation);

  const selected = pickAudienceCompatibleExperience("kids", [
    adultSubjectFallback,
    kidsRecommendation,
  ]);
  assertEquals(selected?.id, "school-life");
  assertEquals(
    pickAudienceCompatibleExperience("kids", [adultSubjectFallback]),
    undefined,
  );
});
