import { describe, expect, it } from "vitest";
import {
  canUseManagementTool,
  confirmationBelongsToActor,
  constantTimeTokenMatches,
  managementActorPhoneCandidates,
  managementPhonesMatch,
  managementToolPolicy,
  shortManagementActionCode,
  whatsappPhoneFromJid,
} from "../supabase/functions/_shared/management-action-policy";

describe("management action policy", () => {
  it("separates temporary coverage from a permanent teacher transfer", () => {
    expect(managementToolPolicy("cobertura_aula")?.toolName).toBe(
      "academics.request_lesson_coverage",
    );
    expect(managementToolPolicy("transferencia_professor")?.toolName).toBe(
      "academics.transfer_student_teacher",
    );
    expect(managementToolPolicy("repasse_aula")?.toolName).toBe(
      "academics.transfer_student_teacher",
    );
  });

  it("limits financial writes to school admins", () => {
    expect(
      canUseManagementTool({
        profileRole: "COORDINATOR",
        membershipRole: "COORDINATOR",
        actionType: "conta_pagar",
      }),
    ).toBe(false);
    expect(
      canUseManagementTool({
        profileRole: "SCHOOL_ADMIN",
        membershipRole: "SCHOOL_ADMIN",
        actionType: "conta_pagar",
      }),
    ).toBe(true);
    expect(
      canUseManagementTool({
        profileRole: "SUPER_ADMIN",
        membershipRole: "SCHOOL_ADMIN",
        actionType: "ajuste_repasse",
      }),
    ).toBe(true);
  });

  it("allows an active academic coordinator to manage schedule and coverage", () => {
    for (const actionType of ["cobertura_aula", "alterar_horario_aluno"]) {
      expect(
        canUseManagementTool({
          profileRole: "COORDINATOR",
          membershipRole: "COORDINATOR",
          actionType,
        }),
      ).toBe(true);
    }
    expect(
      canUseManagementTool({
        profileRole: "COORDINATOR",
        membershipRole: "COORDINATOR",
        actionType: "transferencia_professor",
      }),
    ).toBe(false);
  });

  it("extracts the real phone participant from group and LID payloads", () => {
    expect(
      managementActorPhoneCandidates({
        key: {
          participant: "54095264137225@lid",
          participantAlt: "557999012820@s.whatsapp.net",
        },
      }),
    ).toEqual(["557999012820"]);
    expect(
      managementActorPhoneCandidates({
        key: { participant: "5511999999999:12@s.whatsapp.net" },
      }),
    ).toEqual(["5511999999999"]);
  });

  it("never treats a group or opaque LID as an actor phone", () => {
    expect(whatsappPhoneFromJid("120363400000000951@g.us")).toBeNull();
    expect(whatsappPhoneFromJid("54095264137225@lid")).toBeNull();
  });

  it("matches a manager phone only with the same country and area code", () => {
    expect(managementPhonesMatch("5511912345678", "(11) 91234-5678")).toBe(
      true,
    );
    expect(managementPhonesMatch("5511912345678", "11 1234-5678")).toBe(
      true,
    );
    expect(managementPhonesMatch("5511912345678", "21 91234-5678")).toBe(
      false,
    );
    expect(managementPhonesMatch("5511912345678", "1234-5678")).toBe(false);
  });

  it("binds confirmation to the same authenticated manager", () => {
    expect(confirmationBelongsToActor("user-a", "user-a")).toBe(true);
    expect(confirmationBelongsToActor("user-a", "user-b")).toBe(false);
    expect(confirmationBelongsToActor(null, "user-a")).toBe(false);
  });

  it("builds a compact confirmation code without leaking the full id", () => {
    expect(
      shortManagementActionCode("49c3e973-a6b5-42cc-9085-acde00112233"),
    ).toBe("49C3E973");
  });

  it("accepts only the exact non-empty webhook token", async () => {
    await expect(constantTimeTokenMatches("secret-123", "secret-123"))
      .resolves.toBe(true);
    await expect(constantTimeTokenMatches("secret-124", "secret-123"))
      .resolves.toBe(false);
    await expect(constantTimeTokenMatches("", "secret-123"))
      .resolves.toBe(false);
  });
});
