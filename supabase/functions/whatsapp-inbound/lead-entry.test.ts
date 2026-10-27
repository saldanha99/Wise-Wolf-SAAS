/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { whatsappEntryEvidence, whatsappEntryNotes } from "./lead-entry.ts";

Deno.test("busca direta e link do número, no formato que a Evolution entrega", () => {
  assertEquals(
    whatsappEntryEvidence({
      contextInfo: {
        entryPointConversionSource: "global_search_new_chat",
        entryPointConversionApp: "whatsapp",
      },
      message: { conversation: "Boa tarde" },
    }),
    {
      whatsapp_entry: "global_search_new_chat",
      whatsapp_entry_app: "whatsapp",
    },
  );
  assertEquals(
    whatsappEntryEvidence({
      contextInfo: { entryPointConversionSource: "phone_number_hyperlink" },
    }),
    { whatsapp_entry: "phone_number_hyperlink" },
  );
});

Deno.test("anúncio do Meta com botão para o WhatsApp traz id, título e host", () => {
  assertEquals(
    whatsappEntryEvidence({
      message: {
        extendedTextMessage: {
          text: "Olá! Quero saber mais",
          contextInfo: {
            conversionSource: "FB_Ads",
            externalAdReply: {
              title: "Inglês para o trabalho\nem 30 min",
              sourceType: "ad",
              sourceId: "120212345678901234",
              sourceUrl: "https://fb.me/abc?x=1",
            },
          },
        },
      },
    }),
    {
      whatsapp_ad: true,
      whatsapp_ad_id: "120212345678901234",
      whatsapp_ad_title: "Inglês para o trabalho em 30 min",
      whatsapp_ad_host: "fb.me",
    },
  );
});

Deno.test("sem pista não inventa origem; valores estranhos são descartados", () => {
  assertEquals(
    whatsappEntryEvidence({ message: { conversation: "Ok!" } }),
    null,
  );
  assertEquals(
    whatsappEntryEvidence({
      contextInfo: { entryPointConversionSource: "x'; drop table--" },
    }),
    null,
  );
  assertEquals(whatsappEntryNotes(null), null);
  assertEquals(
    whatsappEntryNotes({ whatsapp_entry: "ctwa_ad", whatsapp_ad: true }),
    'Origem: {"whatsapp_entry":"ctwa_ad","whatsapp_ad":true}',
  );
});
