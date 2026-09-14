/** Run only by an explicitly authorized operator with configured credentials.
 * No secret discovery, wallet scripts, provider writes, or automatic retries. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { resolveAsaasIntegration } from "../../supabase/functions/_shared/tenant-integration-broker.ts";
import {
  adjudicate,
  type Integration,
  type Manifest,
  parseManifest,
  type Row,
} from "./core.ts";

function hexJson(value: unknown): string {
  return Array.from(
    new TextEncoder().encode(JSON.stringify(value)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function operatorSql(
  manifest: Manifest,
  proofs: Row[],
  integration: Integration,
  commit: boolean,
): string {
  // The only interpolated payloads are hex; no shell/SQL interpolation of a
  // manifest's text, provider ID, reason, or operator label is possible.
  const payload = hexJson({
    manifest,
    proofs,
    integration_id: integration.integrationId,
    version: integration.version,
    commit,
  });
  return `begin;
set local statement_timeout='30s';
set local lock_timeout='10s';
set local log_statement='none';
set local log_min_error_statement='panic';
with input as (select convert_from(decode('${payload}','hex'),'UTF8')::jsonb v)
select private.apply_asaas_payment_adjudication_batch(v->'manifest',v->'proofs',(v->>'integration_id')::uuid,
 (v->>'version')::bigint,(v->>'commit')::boolean) from input;
${commit ? "commit" : "rollback"};
`;
}
async function executeSql(sql: string): Promise<Row> {
  const command = new Deno.Command("ssh", {
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "wisewolf-vps",
      "docker",
      "exec",
      "-i",
      "supabase-db",
      "psql",
      "-X",
      "-qAt",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await command.output();
  if (!result.success) {
    // A failed connection may follow COMMIT. Never report a rollback/redo as
    // certain, nor print PostgreSQL's full context containing private input.
    throw new Error(
      "database_result_unconfirmed_check_same_batch_before_retry",
    );
  }
  const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
  const row = lines.findLast((line) => line.startsWith("{"));
  if (!row) throw new Error("database_response_missing");
  return JSON.parse(row) as Row;
}
export async function main(args: string[]) {
  const manifestFlag = args.indexOf("--manifest");
  const commit = args.includes("--commit");
  const confirmFlag = args.indexOf("--confirm-batch");
  const allowed = new Set(["--manifest", "--commit", "--confirm-batch"]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error("unsupported_argument");
    if (args[i] !== "--commit") i++;
  }
  if (manifestFlag < 0 || !args[manifestFlag + 1]?.startsWith("/")) {
    throw new Error("absolute_private_manifest_required");
  }
  const path = await Deno.realPath(args[manifestFlag + 1]);
  const repository = await Deno.realPath(
    new URL("../../", import.meta.url).pathname,
  );
  if (path === repository || path.startsWith(`${repository}/`)) {
    throw new Error("private_manifest_must_be_outside_repository");
  }
  const info = await Deno.stat(path);
  if (
    !info.isFile || info.size > 40_000 ||
    (info.mode != null && (info.mode & 0o077) !== 0)
  ) throw new Error("manifest_requires_private_file_permissions");
  const manifest = parseManifest(JSON.parse(await Deno.readTextFile(path)));
  if (
    commit && (confirmFlag < 0 || args[confirmFlag + 1] !== manifest.batch_id)
  ) throw new Error("explicit_batch_confirmation_required");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !/^https:\/\//.test(url)) {
    throw new Error("configured_supabase_https_environment_required");
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await adjudicate(manifest, {
    resolve: async () => {
      const integration = await resolveAsaasIntegration(
        client,
        "school-wise-wolf",
        "payment.read",
      );
      if (
        integration.mode !== "PLATFORM_MANAGED_ROOT" ||
        integration.environment !== "platform" ||
        integration.baseUrl !== "https://api.asaas.com/v3"
      ) throw new Error("root_production_integration_required");
      return integration as Integration;
    },
    get: async (integration, path) => {
      const response = await fetch(`${integration.baseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: {
          accept: "application/json",
          access_token: integration.apiKey,
        },
      });
      if (!response.ok) throw new Error("provider_get_failed_no_mutation");
      return await response.json();
    },
    apply: (plan, proofs, integration, confirmed) =>
      executeSql(operatorSql(plan, proofs, integration, confirmed)),
  }, commit);
  // SQL returns case keys and numeric totals only: no student/provider/customer
  // IDs, personal fields, raw snapshots or credentials in the public log.
  console.log(JSON.stringify(result));
}
if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    const code = error instanceof Error ? error.message : "operation_failed";
    console.error(
      /^[a-z0-9_]+$/.test(code)
        ? code
        : "operation_failed_private_details_suppressed",
    );
    Deno.exit(1);
  }
}
