export type StudentPaymentType =
  | "ENROLLMENT"
  | "PRO_RATA"
  | "REFUND"
  | "SUBSCRIPTION";

export function classifyStudentPaymentType(
  description: unknown,
  externalReference: unknown,
): StudentPaymentType {
  const normalizedDescription = String(description || "").trim().toLowerCase();
  const normalizedReference = String(externalReference || "").trim().toLowerCase();

  if (
    normalizedReference.endsWith(":fee") ||
    normalizedDescription.includes("matrícula") ||
    normalizedDescription.includes("matricula")
  ) {
    return "ENROLLMENT";
  }
  if (
    normalizedReference.endsWith(":pro-rata") ||
    normalizedDescription.includes("pro-rata") ||
    normalizedDescription.includes("proporcional")
  ) {
    return "PRO_RATA";
  }
  if (
    normalizedDescription.includes("reembolso") ||
    normalizedDescription.includes("refund")
  ) {
    return "REFUND";
  }
  return "SUBSCRIPTION";
}
