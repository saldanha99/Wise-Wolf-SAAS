export function buildRealtimeCallForm(
  sdp: string,
  session: Record<string, unknown>,
): FormData {
  const form = new FormData();
  // The GA unified interface requires both multipart fields as text values.
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));
  return form;
}
