/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function sliceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing source marker: ${start}`);
  assert(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

Deno.test(
  "non-SaaS/non-Hub subscription events expose their full identity to the correction ledger",
  () => {
    const helper = sliceBetween(
      "async function observeStudentBillingScheduleSubscriptionEvent",
      "async function dispatchPersistedAsaasEvent",
    );
    for (
      const contract of [
        '"observe_asaas_student_billing_schedule_event"',
        "p_provider_event_id: providerEventId",
        "p_event_name: eventName",
        "p_subscription_id: subscriptionId",
        "p_customer_id: customerId",
        "p_provider_status: providerStatus",
        "p_provider_event_at: providerEventAt",
        "p_payload: body",
      ]
    ) {
      assert(helper.includes(contract), `missing RPC contract: ${contract}`);
    }
    assert(
      helper.includes(
        "const providerEventAt = explicitTimezoneProviderEventAt(body.dateCreated)",
      ) && !helper.includes("asaasDateToIso(body.dateCreated)") &&
        !helper.includes("!providerEventAt"),
      "a zone-less provider dateCreated must stay optional and cannot be re-labelled as UTC",
    );
    const timestampHelper = sliceBetween(
      "function explicitTimezoneProviderEventAt",
      "async function observeStudentBillingScheduleSubscriptionEvent",
    );
    assert(
      timestampHelper.includes("(?:Z|[+-]\\d{2}:\\d{2})") &&
        timestampHelper.includes("return") && timestampHelper.includes("null"),
      "only an explicitly zoned timestamp may leave the raw payload",
    );

    const dispatch = sliceBetween(
      "async function dispatchPersistedAsaasEvent",
      "async function drainAsaasWebhookInbox",
    );
    const saasRoute = dispatch.indexOf("await processSaasCheckoutEvent");
    const hubRoute = dispatch.indexOf("await processHubPaymentEvent");
    const scheduleRoute = dispatch.indexOf(
      "await observeStudentBillingScheduleSubscriptionEvent",
    );
    const legacyTriage = dispatch.indexOf(
      'throw new AsaasTriageError("unsupported_unrouted_asaas_event")',
    );
    assert(
      saasRoute >= 0 && hubRoute > saasRoute && scheduleRoute > hubRoute &&
        legacyTriage > scheduleRoute,
      "schedule observation must run only after SaaS/Hub routing and before legacy triage",
    );
    assert(
      dispatch.slice(scheduleRoute - 40, scheduleRoute).includes(
        "body.subscription",
      ),
      "payment events must not be promoted into the subscription correction route",
    );
  },
);

Deno.test(
  "handled, unhandled and duplicate observations preserve deterministic routing",
  () => {
    const helper = sliceBetween(
      "async function observeStudentBillingScheduleSubscriptionEvent",
      "async function dispatchPersistedAsaasEvent",
    );
    assert(
      helper.includes(
        "return (data as StudentBillingScheduleObservation).handled === true",
      ),
      "the RPC handled flag must be the only positive routing decision",
    );
    assert(
      !helper.includes("duplicate === true") &&
        !helper.includes("duplicate !== true"),
      "duplicate metadata must neither promote nor reject an observation",
    );

    const disposition = (observation: {
      handled: boolean;
      duplicate?: boolean;
    }) => observation.handled === true ? "HANDLED" : "UNHANDLED";
    assert(
      disposition({ handled: true }) === "HANDLED" &&
        disposition({ handled: true, duplicate: true }) === "HANDLED",
      "a correlated replay must remain handled",
    );
    assert(
      disposition({ handled: false }) === "UNHANDLED" &&
        disposition({ handled: false, duplicate: true }) === "UNHANDLED",
      "duplicate metadata cannot swallow an unhandled subscription event",
    );
  },
);

Deno.test(
  "schedule observation RPC failures remain retryable and never become triage",
  () => {
    const helper = sliceBetween(
      "async function observeStudentBillingScheduleSubscriptionEvent",
      "async function dispatchPersistedAsaasEvent",
    );
    const rpcFailure = helper.slice(
      helper.indexOf("if (error)"),
      helper.indexOf("if (\n    !data"),
    );
    assert(
      rpcFailure.includes("throw new Error(") &&
        !rpcFailure.includes("AsaasTriageError"),
      "transient RPC errors must be released to the durable RETRY path",
    );
    assert(
      helper.includes(
        'throw new Error("student_billing_schedule_observation_invalid_result")',
      ),
      "an invalid RPC response must fail closed and retry",
    );
  },
);

Deno.test(
  "recurring PAYMENT_CREATED parent lookup retries transient provider failures",
  () => {
    const lookup = sliceBetween(
      "let parentResponse: Response;",
      "const parentReference = String(",
    );
    assert(
      lookup.includes(
        'throw new Error("provider_subscription_identity_lookup_unavailable")',
      ),
      "network, timeout and malformed success responses must retry",
    );
    assert(
      lookup.includes('"provider_subscription_identity_not_found"') &&
        lookup.includes("throw new AsaasTriageError("),
      "only a definitive 404 lookup may remain triage",
    );
    assert(
      lookup.includes("parentResponse.status === 404") &&
        !lookup.includes("parentResponse.status === 408") &&
        !lookup.includes("parentResponse.status === 429") &&
        !lookup.includes("parentResponse.status >= 500") &&
        !lookup.includes("provider_subscription_identity_lookup_rejected"),
      "every non-404 HTTP failure must remain retryable",
    );
    assert(
      !/new AsaasTriageError\(\s*["']provider_subscription_identity_lookup_unavailable["']/
        .test(
          lookup,
        ),
      "lookup-unavailable failures must never be classified as triage",
    );

    const mismatch = sliceBetween(
      "if (\n          !providerGeneratedSubscriptionPaymentMatches(",
      "studentId = subscriptionProfile.id;",
    );
    assert(
      mismatch.includes('"provider_subscription_identity_mismatch"') &&
        mismatch.includes("throw new AsaasTriageError("),
      "a fully observed parent identity mismatch must remain triage",
    );
  },
);
