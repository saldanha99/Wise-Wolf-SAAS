/// <reference lib="deno.ns" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  authorizeRequest,
  loadOperationalTenantAccess,
} from "../_shared/request-auth.ts";
import {
  ANALYSIS_PROMPT,
  assertResource,
  base64url,
  Entry,
  MEET_SCOPES,
  normalizeProposal,
  seal,
  sha256,
  unseal,
  validMeetingUri,
} from "./core.ts";
import {
  accessToken,
  configured,
  enabledTenants,
  env,
  googleRequest,
  meet,
  MeetError,
  pages,
} from "./google.ts";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const dbClient = () =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
type DB = ReturnType<typeof dbClient>;
function checked<T>(result: { data: T; error: any }): T {
  if (result.error) throw new MeetError("storage_unavailable", 503);
  return result.data;
}
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new MeetError("invalid_id");
  }
  return value;
};
async function booking(
  db: DB,
  bookingId: string,
  tenant: string,
  teacher: string,
) {
  const row = checked(
    await db.from("bookings").select(
      "id,tenant_id,teacher_id,student_id,status",
    ).eq("id", bookingId).eq("tenant_id", tenant).eq("teacher_id", teacher)
      .maybeSingle(),
  );
  if (!row || String(row.status).toUpperCase() !== "SCHEDULED") {
    throw new MeetError("booking_not_authorized", 403);
  }
  const student = checked(
    await db.from("profiles").select("id").eq("id", row.student_id).eq(
      "tenant_id",
      tenant,
    ).eq("role", "STUDENT").eq("lifecycle_status", "active").maybeSingle(),
  );
  if (!student) throw new MeetError("student_unavailable", 403);
  return row;
}
async function connectionFor(db: DB, tenant: string, teacher: string) {
  const row = checked(
    await db.from("meet_connections").select("*").eq("tenant_id", tenant).eq(
      "teacher_id",
      teacher,
    ).maybeSingle(),
  );
  if (!row) throw new MeetError("google_connection_required", 409);
  return row;
}
async function roomFor(
  db: DB,
  roomId: string,
  tenant: string,
  teacher: string,
) {
  const row = checked(
    await db.from("meet_rooms").select("*").eq("id", roomId).eq(
      "tenant_id",
      tenant,
    ).eq("teacher_id", teacher).maybeSingle(),
  );
  if (!row) throw new MeetError("room_not_authorized", 403);
  const b = await booking(db, row.booking_id, tenant, teacher);
  if (b.student_id !== row.student_id) {
    throw new MeetError("room_student_changed", 409);
  }
  return row;
}
async function callback(req: Request) {
  if (!configured()) return json({ error: "google_not_configured" }, 503);
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state") || "";
  if (!/^[\w-]{43}$/.test(rawState)) {
    return json({ error: "invalid_oauth_state" }, 400);
  }
  const db = dbClient();
  const states = checked(
    await db.from("meet_oauth_states").delete().eq(
      "state_hash",
      await sha256(rawState),
    ).gt("expires_at", new Date().toISOString()).select("*"),
  );
  const state = states?.[0];
  if (!state) return json({ error: "expired_oauth_state" }, 400);
  if (!enabledTenants().includes(state.tenant_id)) {
    throw new MeetError("google_not_configured", 503);
  }
  if (url.searchParams.has("error")) {
    return json({ error: "google_authorization_declined" }, 400);
  }
  const code = url.searchParams.get("code");
  if (!code) return json({ error: "missing_oauth_code" }, 400);
  const member = checked(
    await db.from("tenant_memberships").select("role").eq(
      "tenant_id",
      state.tenant_id,
    ).eq("user_id", state.teacher_id).eq("status", "ACTIVE").maybeSingle(),
  );
  const profile = checked(
    await db.from("profiles").select("lifecycle_status").eq(
      "id",
      state.teacher_id,
    ).maybeSingle(),
  );
  const operational = await loadOperationalTenantAccess(db, state.tenant_id);
  if (
    member?.role !== "TEACHER" || profile?.lifecycle_status !== "active" ||
    !operational.ok || !operational.operational
  ) throw new MeetError("membership_inactive", 403);
  const tokens = await googleRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_MEET_CLIENT_ID"),
      client_secret: env("GOOGLE_MEET_CLIENT_SECRET"),
      redirect_uri: env("GOOGLE_MEET_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
  });
  const granted = new Set(String(tokens.scope || "").split(" "));
  if (
    MEET_SCOPES.filter((s) => s.startsWith("https://")).some((s) =>
      !granted.has(s)
    )
  ) throw new MeetError("google_scopes_missing");
  const user = await googleRequest(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!user.sub || !user.email || user.email_verified !== true) {
    throw new MeetError("google_email_unverified");
  }
  // Domain is a server allowlist, not the OAuth hd hint or a browser assertion.
  const domains = env("GOOGLE_MEET_ALLOWED_DOMAINS").split(",").map((x) =>
    x.trim().toLowerCase()
  ).filter(Boolean);
  if (
    domains.length && !domains.includes(String(user.hd || "").toLowerCase())
  ) throw new MeetError("google_school_account_required");
  const existing = checked(
    await db.from("meet_connections").select(
      "google_sub,encrypted_refresh_token",
    ).eq("tenant_id", state.tenant_id).eq("teacher_id", state.teacher_id)
      .maybeSingle(),
  );
  const rooms = checked(
    await db.from("meet_rooms").select("google_sub").eq(
      "tenant_id",
      state.tenant_id,
    ).eq("teacher_id", state.teacher_id).limit(1),
  );
  if (rooms?.length && rooms[0].google_sub !== user.sub) {
    throw new MeetError("google_account_has_existing_rooms");
  }
  const encrypted = tokens.refresh_token
    ? await seal(
      tokens.refresh_token,
      env("GOOGLE_MEET_TOKEN_KEY"),
      `${state.tenant_id}:${state.teacher_id}`,
    )
    : existing?.google_sub === user.sub
    ? existing?.encrypted_refresh_token
    : null;
  if (!encrypted) throw new MeetError("google_offline_access_required");
  checked(
    await db.from("meet_connections").upsert({
      tenant_id: state.tenant_id,
      teacher_id: state.teacher_id,
      google_sub: user.sub,
      email: user.email,
      encrypted_refresh_token: encrypted,
    }, { onConflict: "tenant_id,teacher_id" }),
  );
  return new Response(
    '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Google conectado</title><body><h1>Conta Google conectada</h1><p>Você pode fechar esta janela e atualizar a conexão na plataforma Wise Wolf.</p></body></html>',
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}
async function syncRoom(db: DB, room: any) {
  const lease = checked(await db.rpc("claim_meet_room", { p_id: room.id }));
  if (!lease) return { busy: true };
  try {
    await roomFor(db, room.id, room.tenant_id, room.teacher_id);
    const conn = await connectionFor(db, room.tenant_id, room.teacher_id);
    if (conn.google_sub !== room.google_sub) {
      throw new MeetError("google_account_changed");
    }
    const token = await accessToken(conn);
    const since = new Date(
      Math.max(Date.parse(room.created_at), Date.now() - 29 * 86400000),
    ).toISOString();
    const filter = `space.name = "${
      assertResource(room.space_name, "spaces")
    }" AND start_time >= "${since}"`;
    const conferences = await pages(
      token,
      "conferenceRecords?filter=" + encodeURIComponent(filter),
      "conferenceRecords",
      5,
    );
    let imported = 0;
    for (const conference of conferences) {
      if (!conference.endTime) continue;
      const conf = assertResource(conference.name, "conferenceRecords");
      const transcripts = await pages(
        token,
        conf + "/transcripts",
        "transcripts",
        5,
      );
      for (const transcript of transcripts) {
        if (transcript.state !== "FILE_GENERATED") continue;
        const name = assertResource(transcript.name, "transcripts");
        const existing = checked(
          await db.from("meet_transcripts").select("id").eq(
            "transcript_name",
            name,
          ).maybeSingle(),
        );
        if (existing) continue;
        const entries = await pages(
          token,
          name + "/entries",
          "transcriptEntries",
        );
        if (!entries.length) continue;
        if (JSON.stringify(entries).length > 400000) {
          throw new MeetError("transcript_too_large");
        }
        const participants = await pages(
          token,
          conf + "/participants",
          "participants",
          5,
        );
        const result = await db.from("meet_transcripts").upsert({
          room_id: room.id,
          tenant_id: room.tenant_id,
          student_id: room.student_id,
          transcript_name: name,
          occurred_at: conference.startTime,
          entries,
          participants: participants.map((p) => ({
            name: p.name,
            displayName: p.signedinUser?.displayName ||
              p.anonymousUser?.displayName || "Participante",
            isOrganizer: p.signedinUser?.user === `users/${conn.google_sub}`,
          })),
        }, { onConflict: "transcript_name", ignoreDuplicates: true });
        checked(result);
        imported++;
      }
    }
    checked(
      await db.from("meet_rooms").update({
        last_sync_at: new Date().toISOString(),
        sync_error: null,
      }).eq("id", room.id).eq("lease_token", lease),
    );
    return { imported };
  } catch (error) {
    checked(
      await db.from("meet_rooms").update({
        last_sync_at: new Date().toISOString(),
        sync_error: error instanceof MeetError ? error.code : "sync_failed",
      }).eq("id", room.id).eq("lease_token", lease),
    );
    throw error;
  } finally {
    await db.from("meet_rooms").update({ lease_until: null, lease_token: null })
      .eq("id", room.id).eq("lease_token", lease);
  }
}
async function analyze(db: DB, t: any, learner: string, teacher: string) {
  if (!env("OPENROUTER_API_KEY")) {
    throw new MeetError("analysis_not_configured", 503);
  }
  if (Date.parse(t.raw_expires_at) < Date.now()) {
    throw new MeetError("transcript_expired");
  }
  if (
    !Array.isArray(t.participants) ||
    !t.participants.some((p: any) => p.name === learner && !p.isOrganizer)
  ) throw new MeetError("select_student_speaker");
  if (!t.entries.some((e: Entry) => e.participant === learner)) {
    throw new MeetError("student_speech_missing");
  }
  const source = JSON.stringify({
    learner_participant: learner,
    entries: t.entries,
  });
  if (source.length > 120000) throw new MeetError("analysis_too_large");
  // Atomic claim and fixed state prevent repeated billable generation after completion.
  const claims = checked(
    await db.from("meet_transcripts").update({
      state: "ANALYZING",
      analysis_started_at: new Date().toISOString(),
      learner_participant: learner,
    }).eq("id", t.id).eq("state", "IMPORTED").select("id"),
  );
  if (!claims?.length) throw new MeetError("analysis_already_started", 409);
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env("GOOGLE_MEET_ANALYSIS_MODEL") || "openai/gpt-4o-mini",
          temperature: 0.1,
          max_tokens: 2200,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: ANALYSIS_PROMPT }, {
            role: "user",
            content: source,
          }],
        }),
        signal: AbortSignal.timeout(45000),
      },
    );
    if (!response.ok) throw new MeetError("analysis_provider_unavailable", 502);
    const data = await response.json();
    const proposal = normalizeProposal(
      JSON.parse(data.choices?.[0]?.message?.content || "null"),
      t.entries,
      learner,
    );
    checked(
      await db.from("meet_transcripts").update({
        state: "REVIEW",
        proposal,
        analysis_cost_usd: data.usage?.cost ?? null,
        analysis_tokens: data.usage?.total_tokens ?? null,
      }).eq("id", t.id).eq("state", "ANALYZING"),
    );
    return { proposal };
  } catch (error) {
    // A request may have been billed. Keep ANALYZING for explicit operator recovery; don't auto-repeat it.
    throw error instanceof MeetError
      ? error
      : new MeetError("analysis_needs_review", 502);
  }
}
export async function handleGoogleMeet(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method === "GET") return await callback(req);
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const auth = await authorizeRequest(req, {
      corsHeaders: cors,
      allowService: true,
      allowedRoles: ["TEACHER", "STUDENT", "SCHOOL_ADMIN", "COORDINATOR"],
    });
    if (auth.ok === false) return auth.response;
    const { admin: db, profile, userId, isService } = auth.context;
    const rawBody = await req.text();
    if (rawBody.length > 4096) throw new MeetError("request_too_large", 413);
    const body = JSON.parse(rawBody);
    const action = String(body.action || "status");
    if (isService) {
      if (action !== "worker") {
        throw new MeetError("service_action_forbidden", 403);
      }
      if (!configured()) return json({ configured: false, processed: 0 });
      checked(
        await db.from("meet_oauth_states").delete().lt(
          "expires_at",
          new Date().toISOString(),
        ),
      );
      checked(
        await db.from("meet_transcripts").update({
          entries: [],
          participants: [],
        }).lt("raw_expires_at", new Date().toISOString()).neq("entries", "[]"),
      );
      const rooms = checked(
        await db.from("meet_rooms").select("*").eq("state", "READY").in(
          "tenant_id",
          enabledTenants(),
        ).order("last_sync_at", { ascending: true, nullsFirst: true }).limit(5),
      );
      let processed = 0, failed = 0;
      for (const room of rooms || []) {
        const active = await loadOperationalTenantAccess(db, room.tenant_id);
        const membership = checked(
          await db.from("tenant_memberships").select("role").eq(
            "tenant_id",
            room.tenant_id,
          ).eq("user_id", room.teacher_id).eq("status", "ACTIVE").maybeSingle(),
        );
        const teacher = checked(
          await db.from("profiles").select("lifecycle_status").eq(
            "id",
            room.teacher_id,
          ).maybeSingle(),
        );
        if (
          !active.ok || !active.operational || membership?.role !== "TEACHER" ||
          teacher?.lifecycle_status !== "active"
        ) {
          await db.from("meet_rooms").update({
            last_sync_at: new Date().toISOString(),
            sync_error: "membership_inactive",
          }).eq("id", room.id);
          continue;
        }
        try {
          await syncRoom(db, room);
          processed++;
        } catch {
          failed++;
        }
      }
      return json({ processed, failed });
    }
    const tenant = profile?.tenant_id;
    if (!tenant || !userId) throw new MeetError("tenant_required", 403);
    if (action === "student_rooms" && profile?.role === "STUDENT") {
      const rooms = checked(
        await db.from("meet_rooms").select(
          "id,booking_id,teacher_id,meeting_uri,state",
        ).eq("tenant_id", tenant).eq("student_id", userId).eq("state", "READY"),
      );
      const bookings = checked(
        await db.from("bookings").select("id,teacher_id").eq(
          "tenant_id",
          tenant,
        ).eq("student_id", userId).in("status", ["SCHEDULED", "scheduled"]),
      );
      return json({
        rooms: (rooms || []).filter((r: any) =>
          (bookings || []).some((b: any) =>
            b.id === r.booking_id && b.teacher_id === r.teacher_id
          )
        ),
      });
    }
    if (action === "status") {
      const conn = checked(
        await db.from("meet_connections").select("email,created_at").eq(
          "tenant_id",
          tenant,
        ).eq("teacher_id", userId).maybeSingle(),
      );
      return json({
        configured: configured() && enabledTenants().includes(tenant),
        connected: Boolean(conn),
        connection: conn,
        schoolDomains: env("GOOGLE_MEET_ALLOWED_DOMAINS").split(",").filter(
          Boolean,
        ),
        analysisConfigured: Boolean(env("OPENROUTER_API_KEY")),
      });
    }
    if (profile?.role !== "TEACHER") {
      throw new MeetError("teacher_required", 403);
    }
    if (action === "list") {
      const bookings = checked(
        await db.from("bookings").select(
          "id,student_id,day_of_week,time_slot,student:student_id(full_name)",
        ).eq("tenant_id", tenant).eq("teacher_id", userId).in("status", [
          "SCHEDULED",
          "scheduled",
        ]),
      );
      const rooms = checked(
        await db.from("meet_rooms").select(
          "id,booking_id,student_id,meeting_uri,state,last_sync_at,sync_error",
        ).eq("tenant_id", tenant).eq("teacher_id", userId),
      );
      return json({
        bookings,
        rooms: (rooms || []).filter((r: any) =>
          (bookings || []).some((b: any) =>
            b.id === r.booking_id && b.student_id === r.student_id
          )
        ),
      });
    }
    if (action === "transcripts") {
      const room = await roomFor(db, id(body.roomId), tenant, userId);
      return json({
        transcripts: checked(
          await db.from("meet_transcripts").select(
            "id,occurred_at,participants,learner_participant,proposal,state,analysis_cost_usd,raw_expires_at",
          ).eq("room_id", room.id).order("occurred_at", { ascending: false })
            .limit(30),
        ),
      });
    }
    if (action === "review") {
      const t = checked(
        await db.from("meet_transcripts").select("id,room_id").eq(
          "id",
          id(body.transcriptId),
        ).eq("tenant_id", tenant).maybeSingle(),
      );
      if (!t) throw new MeetError("transcript_not_found", 404);
      await roomFor(db, t.room_id, tenant, userId);
      if (typeof body.approve !== "boolean") {
        throw new MeetError("invalid_review");
      }
      checked(
        await db.rpc("review_meet_transcript", {
          p_id: t.id,
          p_tenant: tenant,
          p_reviewer: userId,
          p_approve: body.approve,
        }),
      );
      return json({ ok: true });
    }
    if (!configured() || !enabledTenants().includes(tenant)) {
      throw new MeetError("google_not_configured", 503);
    }
    if (action === "connect") {
      // Expired one-use states are cleaned without logging bearer or OAuth codes.
      checked(
        await db.from("meet_oauth_states").delete().eq("teacher_id", userId).eq(
          "tenant_id",
          tenant,
        ),
      );
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
      checked(
        await db.from("meet_oauth_states").insert({
          state_hash: await sha256(state),
          teacher_id: userId,
          tenant_id: tenant,
          expires_at: new Date(Date.now() + 600000).toISOString(),
        }),
      );
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: env("GOOGLE_MEET_CLIENT_ID"),
        redirect_uri: env("GOOGLE_MEET_REDIRECT_URI"),
        response_type: "code",
        scope: MEET_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        state,
      }).toString();
      return json({ url: url.toString() });
    }
    if (action === "disconnect") {
      const conn = await connectionFor(db, tenant, userId);
      // Local disconnection is effective even if remote revocation is unavailable.
      try {
        const token = await unseal(
          conn.encrypted_refresh_token,
          env("GOOGLE_MEET_TOKEN_KEY"),
          `${tenant}:${userId}`,
        );
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* deletion below still removes local access */ }
      checked(await db.from("meet_connections").delete().eq("id", conn.id));
      checked(
        await db.from("meet_oauth_states").delete().eq("tenant_id", tenant).eq(
          "teacher_id",
          userId,
        ),
      );
      return json({ ok: true });
    }
    if (action === "create_room") {
      if (body.consentConfirmed !== true) {
        throw new MeetError("consent_confirmation_required");
      }
      const b = await booking(db, id(body.bookingId), tenant, userId);
      const existing = checked(
        await db.from("meet_rooms").select("*").eq("booking_id", b.id).eq(
          "teacher_id",
          userId,
        ).maybeSingle(),
      );
      if (existing) {
        if (existing.student_id !== b.student_id) {
          throw new MeetError("room_student_changed", 409);
        }
        if (existing.state !== "READY") {
          throw new MeetError("room_creation_needs_review", 409);
        }
        return json({ room: existing });
      }
      const conn = await connectionFor(db, tenant, userId);
      const token = await accessToken(conn);
      const reserved = await db.from("meet_rooms").insert({
        tenant_id: tenant,
        teacher_id: userId,
        student_id: b.student_id,
        booking_id: b.id,
        google_sub: conn.google_sub,
        consent_confirmed_at: new Date().toISOString(),
      }).select("id").single();
      if (reserved.error) throw new MeetError("room_creation_in_progress", 409);
      try {
        const space = await meet(token, "spaces", {
          method: "POST",
          body: JSON.stringify({
            config: {
              accessType: "RESTRICTED",
              artifactConfig: {
                transcriptionConfig: { autoTranscriptionGeneration: "ON" },
                recordingConfig: { autoRecordingGeneration: "OFF" },
              },
            },
          }),
        });
        assertResource(space.name, "spaces");
        if (!validMeetingUri(space.meetingUri)) {
          throw new MeetError("invalid_google_room");
        }
        const room = checked(
          await db.from("meet_rooms").update({
            space_name: space.name,
            meeting_uri: space.meetingUri,
            state: "READY",
          }).eq("id", reserved.data.id).select("id,meeting_uri,state").single(),
        );
        return json({ room });
      } catch (error) {
        await db.from("meet_rooms").update({ state: "REVIEW" }).eq(
          "id",
          reserved.data.id,
        );
        throw error;
      }
    }
    if (action === "sync") {
      return json(
        await syncRoom(db, await roomFor(db, id(body.roomId), tenant, userId)),
      );
    }
    if (action === "analyze") {
      const t = checked(
        await db.from("meet_transcripts").select("*").eq(
          "id",
          id(body.transcriptId),
        ).eq("tenant_id", tenant).maybeSingle(),
      );
      if (!t) throw new MeetError("transcript_not_found", 404);
      await roomFor(db, t.room_id, tenant, userId);
      return json(
        await analyze(db, t, String(body.learnerParticipant || ""), userId),
      );
    }
    throw new MeetError("unknown_action");
  } catch (error) {
    return json({
      error: error instanceof MeetError ? error.code : "operation_failed",
    }, error instanceof MeetError ? error.status : 500);
  }
}

if (import.meta.main) Deno.serve(handleGoogleMeet);
