/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "student context reads financial fields through the authorized RPC",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const projectionMatch = source.match(
      /const profileColumns = \[([\s\S]*?)\]\.join\(","\);/,
    );
    assert(Boolean(projectionMatch), "profile projection must remain explicit");

    const projection = projectionMatch?.[1] ?? "";
    for (
      const privateColumn of [
        "monthly_fee",
        "due_day",
        "status_financial",
        "paid_through",
        "prepaid_months",
      ]
    ) {
      assert(
        !projection.includes(`"${privateColumn}"`),
        `${privateColumn} must not be selected from the directory projection`,
      );
      assert(
        source.includes(`privateProfile.${privateColumn}`),
        `${privateColumn} must be picked explicitly from the private RPC`,
      );
    }

    assert(
      source.includes('supabase.rpc("get_authorized_profile_private"'),
      "student self-service must use the authorized private-profile RPC",
    );
    assert(
      !source.includes("...privateProfile,"),
      "private profile data must never be spread into the public response",
    );
  },
});
