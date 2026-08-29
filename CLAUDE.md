# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Formularhilfe: an Astro static site that turns German/Austrian Behörden-Anträge (Wohngeld, Kinderzuschlag, Elterngeld) into multi-step wizard forms. On submit, the wizard POSTs JSON to an external n8n webhook, which validates the data, renders a PDF, and emails it to the applicant. Currently only the Wohngeld wizard is fully built; Kinderzuschlag and Elterngeld are placeholder pages.

## Commands

```sh
npm run dev              # dev server at localhost:4321 (or: astro dev --background / astro dev stop / astro dev status)
npm run build             # static build to ./dist (also runs a types sync)
npx astro check           # typecheck .astro files + TS (no separate lint/test setup exists in this repo)
npm run preview           # serve ./dist locally
```

There is no test suite and no linter configured — `astro check` is the only automated verification available before deploying.

### Deploying

This app is **not** served from its own domain. It's built statically and rsynced into a subpath of an already-running Nginx site (a separate personal portfolio project) on the production host:

```sh
npm run build
rsync -a --delete dist/ /var/www/agentic-code.at/html/behoerden-antraege/
chown -R www-data:www-data /var/www/agentic-code.at/html/behoerden-antraege
find /var/www/agentic-code.at/html/behoerden-antraege -type d -exec chmod 755 {} \;
find /var/www/agentic-code.at/html/behoerden-antraege -type f -exec chmod 644 {} \;
```

Live at `https://agentic-code.at/behoerden-antraege/`. There is no CI/deploy script for this — it's a manual step after every change meant to go live.

## Architecture

### Base-path routing (`src/lib/base.ts`)

`astro.config.mjs` sets `base: '/behoerden-antraege'` because the site lives under a subpath, not a domain root. `import.meta.env.BASE_URL` in this Astro version has **no trailing slash**, so every internal link/redirect must go through the `withBase(path)` helper in `src/lib/base.ts` (which normalizes the slash) instead of concatenating `BASE_URL` directly or hardcoding absolute `href="/..."` paths. This applies inside `.astro` frontmatter and inside client `<script>` tags (see the redirect in `wohngeld.astro`). Hardcoding an absolute path is the most common way to silently break navigation after a build.

### Wizard form pattern (`src/pages/wohngeld.astro`)

No form framework — plain HTML `<section data-step="N">` blocks toggled via a vanilla client `<script>`. `src/pages/pflegegeld.astro` is a second, independent copy of the same engine (3 steps instead of 5) — there's no shared wizard component, each `.astro` page duplicates the full step/validation/progress-bar script. Notable non-obvious pieces if extending this or building the Kinderzuschlag/Elterngeld wizards the same way:

- Per-step validation uses native HTML5 constraint validation (`checkValidity`/`reportValidity`) with German messages injected via `setCustomValidity` on the `invalid` event, not the browser's default (English-locale) messages.
- **Radio groups**: clearing `customValidity` must happen on *every* radio in the group when any one of them changes, not just the one the user touched — otherwise a stale "field missing" error can get stuck on an unselected sibling and permanently block the step even after a valid choice is made (this was a real bug, fixed once already).
- The wizard step transition (opacity/translate) and the progress bar are plain class toggles, no animation library.
- `PUBLIC_WEBHOOK_URL` is read via `import.meta.env` and is **baked in at build time** since this is a static site — changing `.env` requires a rebuild + redeploy, not just an env change on the server.

### Backend contract (external — not in this repo)

The wizard POSTs to `PUBLIC_WEBHOOK_URL` with:
```json
{ "antragstyp": "wohngeld", "formData": { "name": "...", "geburtsdatum": "...", "strasse": "...", "plz": "...", "ort": "...", "haushaltsgroesse": "...", "bruttoeinkommen": "...", "sozialleistungen": "ja|nein", "kaltmiete": "...", "nebenkosten": "..." }, "email": "..." }
```
Expected response: `{ "success": true, "message": "..." }` (or `success: false` with a 4xx). Required fields differ per `antragstyp` — see the field lists under "Antragstypen" below. Kinderzuschlag/Elterngeld aren't built as wizards yet but are already validated for in the n8n workflow.

The actual n8n + Gotenberg (self-hosted HTML→PDF) infrastructure runs on the host outside this repo (docker-compose, SMTP credentials, env vars). What's checked into this repo is the exportable source of truth for re-importing it:

- `n8n/wohngeld-antrag-workflow.json` — the n8n workflow (Webhook → Switch on `antragstyp` → validate Code node with an error-output branch for missing fields → Code node that builds the PDF HTML inline → HTTP Request to Gotenberg → Send Email → Respond to Webhook). Re-import via `n8n import:workflow --input=...`. The Code node that builds PDF HTML has a per-type render function (`renderWohngeld`, `renderPflegegeld`) with a generic key-value fallback (`renderGeneric`) for antragstyp values without a dedicated one (currently Kinderzuschlag/Elterngeld) — add a new `render*` function there when giving another Antragstyp a proper layout. **After every re-import, `n8n import:workflow` always deactivates the workflow** (even if the JSON's top-level `active` is `true`) as a safety measure; re-activate with `n8n publish:workflow --id=<id>` and then **restart the n8n container** — activation changes (including reactivating after import) don't take effect on a running instance until restart. n8n's `$env` access in expressions needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` set or `$env.*` silently resolves to `undefined`.
- `n8n/wohngeld-antrag-template.html` — a separate, more formal "official document" HTML template with `{{placeholder}}` tokens (documented in its own header comment). **This is not currently wired into the workflow** — the workflow's Code node builds its own (different-looking, more brand-styled) HTML independently via template literals. Don't assume editing one affects the other.

### Paywall (n8n Code nodes + JSON files, no database)

The same n8n workflow also implements a "first 3 free, then pay" gate, admin-configurable per `antragstyp`. No Baserow/Postgres — deliberately kept to flat JSON files inside the existing `n8n_data` docker volume (chosen over a full Baserow stack because the host only has ~750MB free RAM with no swap; see conversation history for the resource check that ruled it out) so it survives container restarts without a new service:
- `/home/node/.n8n/formularhilfe-data/config.json` — `{ [antragstyp]: boolean }`, whether that form is behind the paywall at all. Written by the `/admin` page (password-gated, `ADMIN_PASSWORD` env var) via the `admin-config` webhook.
- `zaehler.json` — `{ [email]: count }`, successful chargeable submissions so far (free-quota uses and paid uses both count). Threshold is 3, hardcoded in the "Bezahlschranke prüfen" Code node.
- `pending.json` — `{ [pendingId]: { antragstyp, formData, email, status } }`, form data stashed when payment is required, so it can be replayed into PDF generation after Stripe confirms payment. `pendingId` is the only thing that leaves n8n (via `client_reference_id`/`metadata` on the Stripe Checkout Session) — full form data never touches Stripe.
- `subscribers.json` — `{ [email]: { subscriptionId, status: "active"|"canceled", since } }`. **Only the `abo` plan writes here** — the `einmalig` (one-time) plan just increments `zaehler` like a free-quota use and grants nothing beyond the one antrag it paid for. `Bezahlschranke prüfen` checks this *before* the `zaehler` count: an active subscriber always gets `paymentRequired: false`, for any kostenpflichtig antragstyp, no count limit. This must stay in sync with the actual Stripe subscription state — see below.

**Critical, easy-to-forget env var:** `NODE_FUNCTION_ALLOW_BUILTIN=fs,crypto,path` — without it every Code node that does `require("fs")` fails with `Module 'fs' is disallowed` (n8n's task-runner sandbox blocks built-in Node modules by default, separately from the `$env` block). Also remember `$env.X`, never raw `process.env.X`, inside these Code nodes — `process` is not defined in the sandbox at all; only `$env` (n8n's own proxy) works, and only because `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is set. The sandbox also has no `URLSearchParams` global (it's not a `require`-able module, so the builtin allowlist above doesn't help) — build `application/x-www-form-urlencoded` bodies by hand with `encodeURIComponent` instead (see `Checkout vorbereiten`, which builds the entire Stripe request body as a string this way rather than using the HTTP Request node's own keypair body-parameter fields — necessary anyway since Stripe rejects `invoice_creation[enabled]` outright, even set to `false`, on non-`payment`-mode sessions, so the field has to be conditionally absent rather than just toggled).

Flow: `Pflichtfelder validieren` (success) → `E-Mail-Verifizierung prüfen` → `Bezahlschranke prüfen` → `Zahlung erforderlich?` (IF) → free branch continues into the pre-existing `HTML-Vorlage befüllen`/PDF/email chain unchanged; paid branch responds `{success:false, paymentRequired:true, pendingId}` (HTTP 402) instead of generating anything. The frontend wizards (`wohngeld.astro`, `pflegegeld.astro`) check for `result.paymentRequired` and redirect to `/bezahlung?pendingId=...&antragstyp=...` instead of showing the generic submit error.

### E-Mail verification (double opt-in, gates the paywall counter)

Since the paywall only ever keys off whatever string the visitor typed into the email field, with nothing to stop someone typing a different fake address on every submission to reset their free quota, first-ever submissions from an address are held back until the address is confirmed:
- `verified.json` — `{ [email]: { verifiedAt } }`, permanent once set — an address only ever needs to verify once, not on every submission.
- `verify-pending.json` — `{ [token]: { antragstyp, formData, email, createdAt } }`, the stashed submission waiting on a click; tokens expire after 24h and are deleted on first use (not reusable).

`E-Mail-Verifizierung prüfen` (inserted right after `Pflichtfelder validieren`, before `Bezahlschranke prüfen`) checks `verified.json`; already-verified emails pass straight through unchanged. A first-time email instead gets a stashed pending entry and a "please confirm" email (`Bestätigungs-E-Mail senden`, its own SMTP node — **has `onError: continueErrorOutput` deliberately, unlike the final PDF-delivery email node**, because a failed *verification* email permanently strands that address with no way to ever submit, versus a failed *delivery* email only affecting one already-processed antrag) — the original `/webhook/antrag` call gets back `{success:false, verificationRequired:true, message}` instead of proceeding.

**The email link does not point at n8n directly** — it points at `src/pages/bestaetigen.astro` (`https://agentic-code.at/behoerden-antraege/bestaetigen?token=...`), a page with an explicit "E-Mail-Adresse bestätigen" button that the visitor must click; only that click fires a `POST /webhook/verify-email` with `{token}` in the body. Two real incidents drove this design, both worth knowing if it's ever tempting to simplify back to a bare link:
1. A raw `n8n.agentic-code.at/webhook/verify-email?token=...` link, GET-triggered straight from an email, got Chrome's live Safe Browsing to flag it as a **phishing (social-engineering) page** — a webhook-shaped URL with a bare token, on a subdomain that only ever serves automation endpoints with no real browsable content, matches classic credential-harvesting link patterns closely enough that it got blocked outright, independent of any actual content. Routing through a real page on the long-established main domain, with real content, avoids the pattern match.
2. GET is semantically supposed to be side-effect-free, so a bare GET link is exactly the shape that email security scanners (Outlook Safe Links, Gmail, antivirus link-prefetchers) auto-visit to check for malware **before the human ever clicks** — silently burning the one-time token first and leaving the real user with "this link is invalid or already used." Making the actual token-consuming call a `POST` triggered only by an explicit button click means passive prefetching of the emailed link can't trigger it.

`Verifizierung abschließen` (now reading the token from `$json.body.token`, not `$json.query.token`) marks the address verified and **feeds the stashed submission into the same shared `Bezahlschranke prüfen` node** used by the wizard (third caller, same reuse pattern as the Stripe webhook feeding `HTML-Vorlage befüllen`) — and since `bestaetigen.astro` calls this over `fetch()` just like the wizard does, everything downstream responds with the same plain JSON as the wizard path; there's no response-type branching to maintain. A `quelle` field (`"wizard"` / `"stripe"` / `"email-verify"`) is still threaded through every node's own return object for this reason alone — nothing in n8n passes extra fields through a node for free — but it's inert metadata now, not used for any branching; a leftover from an earlier version of this feature that did fork the response type, since a first attempt used a bare redirect-based link (see above).

Two more webhooks live in this same workflow:
- `POST /webhook/checkout` — `/bezahlung` page calls this with `{pendingId, plan: "einmalig"|"abo"}`; it looks up the pending entry, creates a Stripe Checkout Session (`mode: payment` vs `subscription`, price IDs from `STRIPE_PRICE_EINMALIG`/`STRIPE_PRICE_ABO`), and returns `{checkoutUrl}` for the page to redirect to.
- `POST /webhook/stripe-webhook` — Stripe's own webhook, listens for two event types (the endpoint's `enabled_events` was updated via the Stripe API after initial creation — re-run that API call, don't just edit `STRIPE_WEBHOOK_SECRET`, if a third event type is ever added). Verifies the `Stripe-Signature` header manually (HMAC-SHA256 over `${timestamp}.${rawBody}` using `STRIPE_WEBHOOK_SECRET`, ±5min replay window) — the Webhook node needs `options.rawBody: true` for this, which puts the raw bytes in `$input.item.binary.data.data` (base64) rather than `$json.body`.
  - `checkout.session.completed`: marks the pending entry paid, increments `zaehler`, and **feeds directly into the same `HTML-Vorlage befüllen` node used by the free path** (one node, multiple incoming callers — no duplicated PDF/email logic between the free and paid paths). If `session.mode === "subscription"`, additionally writes `subscribers.json` with `session.subscription` (Stripe's Subscription ID) as `subscriptionId` — this is the ID a later cancellation event will be matched against, since the cancellation event carries no email address.
  - `customer.subscription.deleted`: fired when a subscription truly ends (Stripe's canonical "it's over" event, as opposed to `.updated` transitioning through various past-due/paused states first). Looks up which email owns `event.data.object.id` by scanning `subscribers.json` values for a matching `subscriptionId` (the event payload has no email), flips that entry to `status: "canceled"`, and responds `{handled:false}` — no PDF to generate for this event type.

**Stripe is configured and verified working (test mode)**: two Prices (one-time 4,99€, recurring monthly 9,99€) and the `checkout.session.completed` webhook endpoint were created via the Stripe API (not the dashboard) using the account's test secret key; all four values (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_EINMALIG`, `STRIPE_PRICE_ABO`) are in `docker-compose.yaml`. One thing that bit us and is easy to hit again on a fresh Stripe account: **Managed Payments** (enabled by default on newer accounts) rejects Checkout Sessions unless the product has a tax code — worked around by passing `managed_payments[enabled]=false` as a body param on the Checkout Session creation request rather than setting up tax codes. If a real production account replaces the test one, redo the Price/webhook creation (or reuse the same curl-via-API approach) and update these four env vars; if Managed Payments is off there, the workaround param is harmless to leave in place. To switch from test to live payments: swap `STRIPE_SECRET_KEY` for the `sk_live_...` key, recreate the two Prices and the webhook endpoint against the live account (test and live mode objects are entirely separate in Stripe), and update all four env vars together — a live secret key paired with test-mode price/webhook IDs (or vice versa) fails immediately.

### Antragstypen field lists (for building the remaining wizards)

- **Wohngeld** (built): Name, Adresse (Straße/PLZ/Ort), Geburtsdatum, Haushaltsgröße, Bruttoeinkommen, Kaltmiete, Nebenkosten, Sozialleistungen (Ja/Nein). PLZ is validated as 4 digits (Austrian format, not German 5-digit).
- **Pflegegeld** (built): Antragsart (dropdown: `zuerkennung` = "die Zuerkennung des Pflegegeldes" / `erhoehung` = "die Erhöhung des Pflegegeldes"), Name, Adresse (Straße/PLZ/Ort). 3 wizard steps (Antragsdetails, Adresse, Zusammenfassung) — deliberately shorter than Wohngeld since it only has these fields.
- **Kinderzuschlag** (placeholder page only): Name, Adresse, Anzahl Kinder, Alter der Kinder, Einkommen, Wohnkosten, Kindergeld-Bezug.
- **Elterngeld** (placeholder page only): Name, Adresse, Geburtstermin Kind, Einkommen vor Geburt, Arbeitgeber, geplante Elternzeit-Monate.

## Design constraints

- Colors: dark blue `#1a365d` (header/accent), white background, green `#38a169` (success/CTA) — defined as Tailwind v4 `@theme` tokens (`brand-blue`, `brand-green`) in `src/styles/global.css`, not arbitrary hex values in components.
- Font: Inter via Google Fonts, loaded in `src/layouts/Layout.astro`.
- Minimum 44px touch targets, real `<label>`s (not placeholder-only), keyboard navigation must work end to end, 4.5:1 contrast minimum — these are hard requirements from the original spec, not suggestions.
- Wizard UX rules: one step per page, max 3–4 fields per step, progress bar always visible, back button on every step but the first, validation per step (not only at the end), final step shows a full summary before submit.
