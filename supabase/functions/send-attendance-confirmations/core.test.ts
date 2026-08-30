/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertMatch,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ATTENDANCE_CLAIM_LIMIT,
  attendanceDeliveryHttpStatus,
  attendanceParticipantsAllowExternalDelivery,
  buildAttendanceConfirmationUrl,
  dedupeAttendanceDeliveries,
  finalizationForEvolutionResult,
  isFreshAttendanceClassDate,
  isFreshAttendanceOccurrence,
  parseAttendanceDeliveryClaims,
  resolveAttendanceDeliveryRecipient,
  resolveAttendancePortal,
  selectAttendancePhone,
} from "./core.ts";

function validClaim(index = 1) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    claim_token: `10000000-0000-4000-8000-${suffix}`,
    tenant_id: "school-a",
    token: `0123456789abcdef${String(index).padStart(8, "0")}`,
    student_name: "Aluno",
    student_id: `20000000-0000-4000-8000-${suffix}`,
    attendance_phone: "5511999999999",
    teacher_id: `30000000-0000-4000-8000-${suffix}`,
    teacher_name: "Professor",
    class_date: "2026-08-28",
    class_time: "08:00",
    delivery_key: `delivery-${index}`,
    session_key: `session-${index}`,
    session_end_at: "2026-08-28T12:00:00.000Z",
  };
}

Deno.test("claim inteiro é validado antes do primeiro envio e limitado a cinco", () => {
  assertEquals(ATTENDANCE_CLAIM_LIMIT, 5);
  assertEquals(parseAttendanceDeliveryClaims(null), []);
  assertEquals(parseAttendanceDeliveryClaims([validClaim(1)]).length, 1);
  assertThrows(
    () =>
      parseAttendanceDeliveryClaims([
        validClaim(1),
        { ...validClaim(2), claim_token: "invalido" },
      ]),
    Error,
    "invalid_attendance_claim_contract",
  );
  assertThrows(
    () =>
      parseAttendanceDeliveryClaims(
        Array.from({ length: 6 }, (_, index) => validClaim(index + 1)),
      ),
    Error,
    "attendance_claim_limit_exceeded",
  );
});

Deno.test("envio externo exige aluno e professor reais, ativos e do tenant", () => {
  const claim = validClaim(1);
  const realProfiles = [
    {
      id: claim.student_id,
      tenant_id: claim.tenant_id,
      role: "STUDENT",
      lifecycle_status: "active",
      is_test_account: false,
    },
    {
      id: claim.teacher_id,
      tenant_id: claim.tenant_id,
      role: "TEACHER",
      lifecycle_status: "ACTIVE",
      is_test_account: false,
    },
  ];

  assertEquals(
    attendanceParticipantsAllowExternalDelivery(claim, realProfiles),
    true,
  );
  assertEquals(
    attendanceParticipantsAllowExternalDelivery(claim, [
      { ...realProfiles[0], is_test_account: true },
      realProfiles[1],
    ]),
    false,
  );
  assertEquals(
    attendanceParticipantsAllowExternalDelivery(claim, [
      realProfiles[0],
      { ...realProfiles[1], is_test_account: true },
    ]),
    false,
  );
  assertEquals(
    attendanceParticipantsAllowExternalDelivery(claim, [
      { ...realProfiles[0], is_test_account: null },
      realProfiles[1],
    ]),
    false,
  );
  assertEquals(
    attendanceParticipantsAllowExternalDelivery(claim, [realProfiles[0]]),
    false,
  );
});

Deno.test("destinatario usa somente o telefone atual do aluno", () => {
  const claim = {
    ...validClaim(1),
    attendance_phone: "5511999990000",
    student_phone: "5511999990001",
  };
  const profiles = [
    {
      id: claim.student_id,
      tenant_id: claim.tenant_id,
      role: "STUDENT",
      lifecycle_status: "active",
      is_test_account: false,
      attendance_phone: "(11) 98888-7777",
      phone: "(11) 97777-6666",
    },
    {
      id: claim.teacher_id,
      tenant_id: claim.tenant_id,
      role: "TEACHER",
      lifecycle_status: "active",
      is_test_account: false,
    },
  ];

  assertEquals(resolveAttendanceDeliveryRecipient(claim, profiles), {
    allowed: true,
    phone: "5511988887777",
  });
  assertEquals(
    resolveAttendanceDeliveryRecipient(claim, [
      { ...profiles[0], attendance_phone: null, phone: null },
      profiles[1],
    ]),
    { allowed: true, phone: null },
  );
});

Deno.test("URL usa domínio HTTPS do tenant e cai no portal institucional legado", () => {
  assertEquals(
    resolveAttendancePortal("https://escola.example.com/"),
    "https://escola.example.com",
  );
  assertEquals(
    resolveAttendancePortal(null, "https://system.wisewolflanguage.com.br/"),
    "https://system.wisewolflanguage.com.br",
  );
  assertEquals(
    resolveAttendancePortal("http://inseguro.example.com", "javascript:bad"),
    "https://system.wisewolflanguage.com.br",
  );
  assertMatch(
    buildAttendanceConfirmationUrl(
      "https://system.wisewolflanguage.com.br",
      "0123456789abcdef01234567",
    ) || "",
    /^https:\/\/system\.wisewolflanguage\.com\.br\/confirmar-presenca\?token=/,
  );
  assertEquals(
    buildAttendanceConfirmationUrl(
      "https://system.wisewolflanguage.com.br",
      "token com espaços",
    ),
    null,
  );
});

Deno.test("telefone de presença válido tem precedência e geral é fallback", () => {
  assertEquals(
    selectAttendancePhone("(11) 98888-7777", "(11) 97777-6666"),
    "5511988887777",
  );
  assertEquals(
    selectAttendancePhone("invalido", "(11) 97777-6666"),
    "5511977776666",
  );
});

Deno.test("dedupe conserva uma única entrega para a chave canônica", () => {
  const rows = [
    { id: "a", delivery_key: "lesson-1", token: "token-a" },
    { id: "b", delivery_key: "lesson-1", token: "token-b" },
    { id: "c", delivery_key: "lesson-2", token: "token-c" },
  ];
  const result = dedupeAttendanceDeliveries(rows);
  assertEquals(result.deliveries.map((row) => row.id), ["a", "c"]);
  assertEquals(result.duplicates.map((row) => row.id), ["b"]);
});

Deno.test("fallback de dedupe usa a ocorrência e não o token", () => {
  const rows = [
    {
      id: "a",
      source_id: "booking-1",
      source_type: "booking",
      class_date: "2026-08-28",
      token: "token-a",
    },
    {
      id: "b",
      source_id: "booking-1",
      source_type: "booking",
      class_date: "2026-08-28",
      token: "token-b",
    },
  ];
  assertEquals(dedupeAttendanceDeliveries(rows).duplicates.length, 1);
  assertEquals(
    dedupeAttendanceDeliveries([
      { ...rows[0], tenant_id: "school-a" },
      { ...rows[1], tenant_id: "school-b" },
    ]).duplicates.length,
    0,
  );
});

Deno.test("resultado ambíguo nunca é convertido em retry automático", () => {
  assertEquals(
    finalizationForEvolutionResult({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 503,
    }),
    {
      action: "fail",
      errorCode: "provider_ambiguous",
      ambiguous: true,
    },
  );
  assertEquals(
    finalizationForEvolutionResult({
      outcome: "accepted",
      messageId: " provider-123 ",
      httpStatus: 200,
    }),
    { action: "complete", providerMessageId: "provider-123" },
  );
  assertEquals(
    finalizationForEvolutionResult({
      outcome: "accepted",
      messageId: null,
      httpStatus: 200,
    }),
    {
      action: "fail",
      errorCode: "provider_ambiguous",
      ambiguous: true,
    },
  );
  assertEquals(
    finalizationForEvolutionResult({
      outcome: "accepted",
      messageId: "   ",
      httpStatus: 200,
    }),
    {
      action: "fail",
      errorCode: "provider_ambiguous",
      ambiguous: true,
    },
  );
});

Deno.test("defesa de backlog aceita só hoje e ontem em São Paulo", () => {
  const now = new Date("2026-08-28T14:59:00.000Z");
  assertEquals(isFreshAttendanceClassDate("2026-08-28", now), true);
  assertEquals(isFreshAttendanceClassDate("2026-08-27", now), true);
  assertEquals(isFreshAttendanceClassDate("2026-08-26", now), false);
  assertEquals(isFreshAttendanceClassDate("2026-08-29", now), false);
  assertEquals(isFreshAttendanceOccurrence("2026-08-28", "08:00", now), true);
  assertEquals(isFreshAttendanceOccurrence("2026-08-27", "23:59", now), true);
  assertEquals(isFreshAttendanceOccurrence("2026-08-27", "08:00", now), false);
  assertEquals(
    isFreshAttendanceOccurrence("2026-08-28", "sem hora", now),
    false,
  );
});

Deno.test("qualquer falha do lote não responde HTTP 2xx", () => {
  assertEquals(
    attendanceDeliveryHttpStatus({
      claimed: 3,
      sent: 0,
      failed: 3,
      suppressed: 0,
    }),
    502,
  );
  assertEquals(
    attendanceDeliveryHttpStatus({
      claimed: 3,
      sent: 1,
      failed: 2,
      suppressed: 0,
    }),
    502,
  );
  assertEquals(
    attendanceDeliveryHttpStatus({
      claimed: 0,
      sent: 0,
      failed: 1,
      suppressed: 0,
    }),
    502,
  );
  assertEquals(
    attendanceDeliveryHttpStatus({
      claimed: 2,
      sent: 0,
      failed: 0,
      suppressed: 2,
    }),
    200,
  );
});
