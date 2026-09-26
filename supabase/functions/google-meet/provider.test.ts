/// <reference lib="deno.ns" />
import { googleErrorInfo, GoogleMeetProvider } from "./provider.ts";

function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  esperado: ${e}\n  recebido: ${a}`);
  }
}
async function assertRejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    assertEquals((error as Error).message, code);
    return;
  }
  throw new Error(`esperava rejeição ${code}`);
}

// Resposta real do Google em 26/09/2026 para accessType RESTRICTED na conta
// Business Plus sobre Gmail.
const ACCESS_TYPE_UNAVAILABLE = {
  error: {
    code: 403,
    message: "updateAccessType is not available to the user.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "FEATURE_UNAVAILABLE_TO_USER",
        domain: "meet.googleapis.com",
        metadata: { feature_name: "updateAccessType" },
      },
    ],
  },
};
const SPACE = {
  name: "spaces/nLYkAE855egB",
  meetingUri: "https://meet.google.com/fxj-hykv-jev",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fakeGoogle(responses: Response[]) {
  const sent: { accessType?: string; attendance?: string }[] = [];
  const request = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    sent.push({
      accessType: body.config?.accessType,
      attendance: body.config?.attendanceReportGenerationType,
    });
    const next = responses.shift();
    if (!next) throw new Error("chamada inesperada");
    return Promise.resolve(next);
  };
  return { sent, request: request as typeof fetch };
}

Deno.test("ErrorInfo do Google vira reason/feature", () => {
  assertEquals(googleErrorInfo(ACCESS_TYPE_UNAVAILABLE), {
    reason: "FEATURE_UNAVAILABLE_TO_USER",
    feature: "updateAccessType",
  });
  assertEquals(googleErrorInfo({ error: { code: 403 } }), {
    reason: "",
    feature: "",
  });
  assertEquals(googleErrorInfo("texto"), { reason: "", feature: "" });
});

Deno.test("conta que aceita RESTRICTED cria a sala restrita, uma chamada só", async () => {
  const google = fakeGoogle([json(SPACE)]);
  const room = await new GoogleMeetProvider("t", google.request).createSpace({
    attendanceReport: true,
  });
  assertEquals(room, {
    space_name: "spaces/nLYkAE855egB",
    meeting_uri: "https://meet.google.com/fxj-hykv-jev",
  });
  assertEquals(google.sent, [{
    accessType: "RESTRICTED",
    attendance: "GENERATE_REPORT",
  }]);
});

Deno.test("Workspace sobre Gmail: RESTRICTED recusado cai para TRUSTED com a mesma configuração", async () => {
  const google = fakeGoogle([json(ACCESS_TYPE_UNAVAILABLE, 403), json(SPACE)]);
  const room = await new GoogleMeetProvider("t", google.request).createSpace({
    attendanceReport: true,
  });
  assertEquals(room.meeting_uri, "https://meet.google.com/fxj-hykv-jev");
  assertEquals(google.sent, [
    { accessType: "RESTRICTED", attendance: "GENERATE_REPORT" },
    { accessType: "TRUSTED", attendance: "GENERATE_REPORT" },
  ]);
});

Deno.test("outro 403 não troca o tipo de acesso por conta própria", async () => {
  const edition = {
    error: {
      code: 403,
      details: [{
        reason: "FEATURE_UNAVAILABLE_TO_USER",
        metadata: { feature_name: "transcription" },
      }],
    },
  };
  const google = fakeGoogle([json(edition, 403)]);
  await assertRejects(
    () => new GoogleMeetProvider("t", google.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(google.sent.length, 1);
  const plain = fakeGoogle([json({ error: { code: 403 } }, 403)]);
  await assertRejects(
    () => new GoogleMeetProvider("t", plain.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(plain.sent.length, 1);
});

Deno.test("TRUSTED também recusado devolve o erro, sem terceira tentativa", async () => {
  const google = fakeGoogle([
    json(ACCESS_TYPE_UNAVAILABLE, 403),
    json(ACCESS_TYPE_UNAVAILABLE, 403),
  ]);
  await assertRejects(
    () => new GoogleMeetProvider("t", google.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(google.sent.length, 2);
});
