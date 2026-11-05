/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { briefingDestination } from "./briefing-destination.ts";

const group = "120363000000000902@g.us";

Deno.test("resumo diário vai para o grupo da Direção, não para o telefone do admin", () => {
  assertEquals(
    briefingDestination({ directionGroup: group, ownerPhone: "11966667773" }),
    group,
  );
});

Deno.test("número escolhido na configuração da equipe de IA vale primeiro", () => {
  assertEquals(
    briefingDestination({
      ownerWhatsapp: "(11) 95555-4441",
      directionGroup: group,
      ownerPhone: "11966667773",
    }),
    "5511955554441",
  );
});

Deno.test("escola sem grupo continua recebendo no telefone do admin", () => {
  assertEquals(
    briefingDestination({ directionGroup: null, ownerPhone: "11966667773" }),
    "5511966667773",
  );
});

Deno.test("sem nenhum destino válido não inventa um", () => {
  assertEquals(briefingDestination({ ownerWhatsapp: "123" }), null);
  assertEquals(briefingDestination({ directionGroup: "  " }), null);
  assertEquals(briefingDestination({}), null);
});
