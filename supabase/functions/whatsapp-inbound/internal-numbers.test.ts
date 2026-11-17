/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isInternalNumber,
  loadInternalNumberKeys,
  ownerPhoneKeys,
  phoneKey,
  resetInternalNumberCacheForTests,
} from "./internal-numbers.ts";

const INSTANCES = [
  { name: "prof-diretorww-d6bg", ownerJid: "5511971681451@s.whatsapp.net" },
  { name: "motofix-master", ownerJid: "5512997146957@s.whatsapp.net" },
  { name: "oficina-tenant-1", ownerJid: "553199887766@s.whatsapp.net" },
  { name: "sem-dono", ownerJid: null },
];

Deno.test("phoneKey casa com e sem o 9º dígito e com/sem 55", () => {
  assertEquals(phoneKey("5512997146957"), phoneKey("12997146957"));
  assertEquals(phoneKey("5531999887766"), phoneKey("553199887766"));
  assertEquals(phoneKey("123"), null);
});

Deno.test("regressão 16/11: número da motofix-master é interno para a Wise Wolf", () => {
  const keys = ownerPhoneKeys(INSTANCES, "prof-diretorww-d6bg");
  assertEquals(isInternalNumber("5512997146957", keys), true);
  assertEquals(isInternalNumber("5531999887766", keys), true);
});

Deno.test("o próprio número da instância e leads comuns não são internos", () => {
  const keys = ownerPhoneKeys(INSTANCES, "prof-diretorww-d6bg");
  assertEquals(isInternalNumber("5511971681451", keys), false);
  assertEquals(isInternalNumber("5512982289432", keys), false);
});

Deno.test("servidor fora do ar não bloqueia ninguém", async () => {
  resetInternalNumberCacheForTests();
  const keys = await loadInternalNumberKeys(
    "https://evo.example",
    "k",
    "prof-diretorww-d6bg",
    () => Promise.reject(new Error("offline")),
  );
  assertEquals(keys.size, 0);
});

Deno.test("lista vem do servidor e fica em cache", async () => {
  resetInternalNumberCacheForTests();
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify(INSTANCES)));
  }) as typeof fetch;
  const a = await loadInternalNumberKeys(
    "https://evo.example",
    "k",
    "prof-diretorww-d6bg",
    fetcher,
    1000,
  );
  const b = await loadInternalNumberKeys(
    "https://evo.example",
    "k",
    "prof-diretorww-d6bg",
    fetcher,
    2000,
  );
  assertEquals(a.size, 2);
  assertEquals(b, a);
  assertEquals(calls, 1);
});
