# Sentry Alerts Runbook

Operational runbook for ShieldKit's Sentry issue alerts.
Org **plucore** · Project **shieldkit**.

---

## Alert 1 — Anthropic model-not-found (SHIELDKIT-1 guard)

### Why this exists

SHIELDKIT-1 was a production incident where an LLM call site (policy generator /
appeal-letter generator) shipped a retired or invalid Anthropic model id. The
Anthropic SDK returns a `404 not_found_error` whose message is shaped like:

```
404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"}}
```

The AI paths are paid-only and rarely exercised, so a bad model id can sit green
in CI and only surface in production. `tests/model-pin.test.ts` guards the source
string; **this alert is the production backstop** for anything the pin test can't
catch (env drift, a model retired by Anthropic after we pinned it, a new call
site).

### How the error reaches Sentry (prerequisite, wired in this PR)

The alert only works if the 404 is actually sent to Sentry, and it is **not**
captured automatically: `@sentry/node`'s Anthropic tracing integration is off
(`tracesSampleRate: 0`), and each generator's route catch turns the throw into a
merchant-facing 500 without reporting it. So both LLM call sites capture the error
explicitly on the `messages.create` failure path (capture-and-rethrow):

- `app/lib/policy-generator.server.ts` — `sentry.captureException(err, { tags: { area: "policy-generator", policy_type } })`
- `app/lib/llm/appeal-letter.server.ts` — `sentry.captureException(err, { tags: { area: "appeal-letter" } })`

The captured event is a manual `captureException` (exception mechanism `generic`,
NOT the `auto.ai.anthropic` span origin), and its message carries the Anthropic
404 body, so it contains both `not_found_error` and `model:` — which is what the
two message filters below match. `tests/model-pin.test.ts` guards that this
capture stays wired.

### Status: created by hand in the Sentry UI (see below)

> **This alert was NOT created by tooling.** The Sentry MCP integration exposes
> only read tools for alert rules (`find_alert_rules`, `get_alert_rule`) — there
> is no create/update capability — and this repo has no alerts-as-code config to
> add it to. So it must be created once, by hand, in the Sentry UI using the
> recipe below. Update this line to "✅ live (rule id NNNN)" once it exists.

### UI recipe — click path

Sentry → **Alerts** → **Create Alert** → **Issues** (issue alert, not metric) →
select project **shieldkit**.

1. **Environment:** `production`
2. **WHEN** (trigger) → `A new issue is created`
   *(this is "first occurrence"; combined with Environment=production it means
   first occurrence in production.)*
3. **IF** (conditions) → set the match dropdown to **all** and add two filters:
   - `The event's message value contains not_found_error`
   - `The event's message value contains model:`

   *(Both `co`ntains filters together pin the SHIELDKIT-1 class: a
   `not_found_error` that names a `model:`. The two message filters are sufficient
   on their own. Optional tightener: because the capture tags the event
   `area=policy-generator` / `area=appeal-letter`, you can add `The event's tags
   match area equals policy-generator` to scope strictly to the policy path. Do
   NOT try to filter on a `mechanism` attribute — a manual captureException has
   mechanism `generic`, and there is no `mechanism` field in the event-attribute
   dropdown.)*
4. **THEN** (action) → `Send a notification to` → **Suggested assignees, Teams,
   and Members** → select the project's default owner (**am@plucore.com** / the
   Plucore owner). If a Slack/PagerDuty integration is preferred, add it as a
   second action.
5. **Action interval:** `60 minutes` (default is fine — a "new issue" trigger
   fires once per issue group anyway).
6. **Alert name:** `Anthropic model-not-found (SHIELDKIT-1)`
7. **Save Rule.**

### Equivalent API payload (for future automation)

If ShieldKit later adopts alerts-as-code or you want to create it via curl, this
is the same rule as a `POST /api/0/projects/plucore/shieldkit/rules/` body.
Requires a Sentry auth token with `alerts:write` (or `project:write`); confirm
the correct region host (`https://sentry.io` or your org's region URL) first.

```json
{
  "name": "Anthropic model-not-found (SHIELDKIT-1)",
  "environment": "production",
  "actionMatch": "all",
  "filterMatch": "all",
  "frequency": 60,
  "conditions": [
    { "id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition" }
  ],
  "filters": [
    {
      "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
      "attribute": "message",
      "match": "co",
      "value": "not_found_error"
    },
    {
      "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
      "attribute": "message",
      "match": "co",
      "value": "model:"
    }
  ],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "IssueOwners",
      "targetIdentifier": "",
      "fallthroughType": "ActiveMembers"
    }
  ]
}
```

`targetType: "IssueOwners"` + `fallthroughType: "ActiveMembers"` is Sentry's
"notify the default owner, else active members" behavior. To notify one specific
person instead, use `"targetType": "Member"` with `"targetIdentifier": "<userId>"`.

```bash
# fill in $SENTRY_TOKEN and confirm the region host before running
curl -sS https://sentry.io/api/0/projects/plucore/shieldkit/rules/ \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d @sentry-model-not-found-rule.json
```

### Verifying it works

Two things must be true for an event to reach this rule:

1. **`SENTRY_DSN` is set in the deploy you are testing.** `app/lib/sentry.server.ts`
   no-ops entirely when the DSN is unset, so an env without it emits nothing.
2. **The event lands in the `production` Sentry environment.** The app derives the
   Sentry `environment` from `NODE_ENV` (`environment: process.env.NODE_ENV ?? "development"`),
   and Vercel sets `NODE_ENV=production` for **preview** deploys as well as prod.
   So a preview deploy (with the DSN set) reports `environment=production` and
   **does** count toward this rule. "First occurrence in production" here means the
   Sentry `production` environment, which includes preview traffic, not only the
   prod domain.

To smoke-test without a real outage: on a deploy that has `SENTRY_DSN` set,
temporarily point a model string at a bogus id, trigger one policy or appeal
generation (a paid-tier action), and confirm the issue appears and the alert
fires. Revert the model string afterward.
