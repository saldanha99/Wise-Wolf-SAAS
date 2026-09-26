/// <reference lib="deno.ns" />

import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OFFICIAL_ROOM_NOTICE } from "../send-class-notification/core.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260830170000_fence_whatsapp_occurrence_receipts.sql",
    import.meta.url,
  ),
);

Deno.test("queue worker seals delivery before its only provider POST", () => {
  const genericFence = source.lastIndexOf("beginNotificationSubmission(");
  const paymentFence = source.lastIndexOf(
    "beginPaymentConfirmationSubmission(",
  );
  const jidLookup = source.lastIndexOf("resolveWhatsAppDestination({");
  const send = source.indexOf(
    "const providerResult = await sendWhatsTextToResolvedDestinationDetailed(",
  );
  const paymentFinish = source.lastIndexOf(
    "finalizePaymentConfirmationSubmission(",
  );

  assert(jidLookup >= 0 && jidLookup < genericFence);
  assert(jidLookup < paymentFence);
  assert(genericFence >= 0 && genericFence < send);
  assert(paymentFence >= 0 && paymentFence < send);
  assert(send >= 0 && send < paymentFinish);
  assert(
    !source.includes('.from("automation_sent").insert(') &&
      !source.includes('.from("automation_sent").delete()'),
    "occurrence receipts must be managed atomically by the database fence",
  );
});

Deno.test("termo fora da janela ou do ritmo é adiado antes da cerca, sem gastar tentativa", () => {
  // O banco manda adiar (janela seg–sáb 9h–20h, 5 a cada 15 min); o worker
  // devolve a vaga por defer_notification_delivery em vez de marcar pending
  // com backoff (que gastaria tentativa e ignoraria a janela).
  const branch = source.indexOf(
    "notificationKind === LESSON_RECORDING_CONSENT_KIND",
  );
  const deferCall = source.indexOf(
    "deferred(delivery.reason, delivery.deferSeconds)",
  );
  const catchDefer = source.indexOf("if (error.deferSeconds !== null) {");
  const genericFence = source.lastIndexOf("beginNotificationSubmission(");
  assert(branch >= 0 && deferCall > branch, "o ramo do termo não adia");
  assert(catchDefer > deferCall && catchDefer < genericFence);
  assertStringIncludes(source, '"defer_notification_delivery"');
});

Deno.test("payment and lesson transitions use purpose-built atomic bridges", () => {
  assertStringIncludes(
    source,
    '"begin_payment_confirmation_delivery_submission"',
  );
  assertStringIncludes(source, '"finalize_payment_confirmation_delivery"');
  assertStringIncludes(source, '"begin_notification_delivery_submission"');
  assertStringIncludes(source, '"recover_notification_delivery_submission"');
  assertStringIncludes(source, "{ p_limit: 5, p_lease_seconds: 300 }");
  assertStringIncludes(migration, "receipt_state = 'SEALED'");
  assertStringIncludes(migration, "notification_provider_binding_changed");
  assertStringIncludes(migration, "notification_queue_sync_lesson_receipt");
  assertStringIncludes(migration, "lesson_authorized_snapshot_changed");
  assertStringIncludes(
    migration,
    "notification_kind_canonical_collision_groups",
  );
  assertStringIncludes(
    migration,
    "provider_destination = v_provider_destination",
  );
  assertStringIncludes(migration.toLowerCase(), "for update");
});

const officialRoomMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260926190000_lembrete_leva_a_sala_oficial.sql",
    import.meta.url,
  ),
);
// A régua de quem dá a aula mora no núcleo do Meet (integração da onda 1): é
// a mesma para o lembrete, o link do app e a fila.
const meetCoreMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260926180000_meet_identidade_do_professor_e_revogacao.sql",
    import.meta.url,
  ),
);

Deno.test("lembrete é montado pelo mesmo renderizador que a cerca confere", () => {
  // O worker não renderiza mais o lembrete sozinho: achatar o modelo e pôr o
  // link pessoal no {class_link} fez a cerca recusar 45 lembretes da Débora.
  assertStringIncludes(source, "canonicalLessonReminder(");
  assertStringIncludes(source, "personalLink: null,");
  assert(
    !source.includes("renderReminderTemplate(") &&
      !source.includes("meeting_link"),
    "o lembrete automático não pode voltar a usar o link pessoal nem renderizar fora do banco",
  );
  // A cerca passa a conferir com o mesmo renderizador e a mesma sala oficial.
  assertStringIncludes(
    officialRoomMigration,
    "v_current_message := public.render_lesson_reminder_message(",
  );
  assertStringIncludes(officialRoomMigration, "public.official_lesson_link(");
  assertStringIncludes(officialRoomMigration, "session.documentation_consent");
  assertStringIncludes(officialRoomMigration, "room.state = 'READY'");
});

Deno.test("sala oficial é a de quem dá a aula, e a sala que muda na hora não descarta o lembrete", () => {
  // Sessão com aceite fica congelada: cobertura ou professor trocado depois
  // mandariam o aluno para a sala do professor ausente.
  assertStringIncludes(
    source,
    "teacherId,\n      template: teacher.lesson_reminder_template",
  );
  assertStringIncludes(
    officialRoomMigration,
    "and session.teacher_id = private.lesson_occurrence_giver(",
  );
  assertStringIncludes(
    meetCoreMigration,
    "create or replace function private.lesson_occurrence_giver(",
  );
  assertStringIncludes(meetCoreMigration, "from public.class_coverages as c");
  // O link do app e a preparação da sala na fila usam a mesma régua: a aula
  // coberta não vai para a sala do ausente por outro caminho.
  assertStringIncludes(
    meetCoreMigration,
    "and not private.lesson_session_taught_by_other(s.id)",
  );
  // Worker e cerca consultam a sala em momentos diferentes: se só a sala mudou,
  // RETRY devolve à fila em vez de marcar 'skipped' para sempre.
  assertStringIncludes(
    officialRoomMigration,
    "'reason', 'official_lesson_room_changed'",
  );
  assertStringIncludes(source, 'effectiveSubmission.action === "RETRY"');
});

Deno.test("frase da sala oficial é a mesma no TypeScript e no SQL", () => {
  assertStringIncludes(officialRoomMigration, `'${OFFICIAL_ROOM_NOTICE}'`);
});
