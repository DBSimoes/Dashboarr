#!/usr/bin/env node
/**
 * Publishes the Android build that `pnpm release:android` left on Play's internal
 * track (eas.json submits it there as a draft) to production, with release notes.
 *
 * Shows what production has now and its notes, asks for the new notes, prints
 * exactly what will change and asks before touching Play. Both tracks change in
 * a single edit, so a failure leaves Play as it was.
 *
 * Usage:
 *   pnpm release:android:promote
 *   pnpm release:android:promote --notes-file notes.txt --yes   # unattended
 *   pnpm release:android:promote --dry-run                      # plan only
 *
 * Auth: the same service account `eas submit` uses (./play-service-account.json).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { FLAGS_HELP, ReleaseError, parseFlags, indent, getNotes, confirm } = require("./release-prompts");

const pkg = require("../package.json");
const VERSION = pkg.version;

const PACKAGE_NAME = "com.dashboarr.app";
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "play-service-account.json");
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}`;
// Play rejects release notes longer than this (per language).
const NOTES_LIMIT = 500;

function log(msg) {
  console.log(`[release-android] ${msg}`);
}

function die(msg, hint) {
  console.error(`\n[release-android] ERROR: ${msg}`);
  if (hint) console.error(`[release-android] ${hint}`);
  process.exit(1);
}

const b64url = (data) => Buffer.from(data).toString("base64url");

let accessToken = null;

// Service-account OAuth: a JWT signed with the account's key, exchanged for an
// access token. Plain fetch + crypto, so the script needs no Google SDK.
async function authenticate() {
  const account = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), account.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new ReleaseError(`Google rejected the service account (${res.status} ${json.error ?? ""}).`, `Check ${SERVICE_ACCOUNT_PATH}.`);
  }
  accessToken = json.access_token;
}

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new ReleaseError(`${method} ${route} failed (${res.status}): ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

// Play changes go through an "edit", a draft of the whole app listing. Reads use
// a throwaway edit and writes commit theirs; an uncommitted edit is always deleted.
async function withEdit(fn, { commit = false } = {}) {
  const { id } = await api("POST", "/edits", {});
  let committed = false;
  try {
    const result = await fn(id);
    if (commit) {
      await api("POST", `/edits/${id}:commit`);
      committed = true;
    }
    return result;
  } finally {
    if (!committed) await api("DELETE", `/edits/${id}`).catch(() => {});
  }
}

async function readTracks() {
  return withEdit(async (id) => {
    const { defaultLanguage } = await api("GET", `/edits/${id}/details`);
    const { tracks = [] } = await api("GET", `/edits/${id}/tracks`);
    const releases = (name) => tracks.find((t) => t.track === name)?.releases ?? [];
    return { language: defaultLanguage, production: releases("production"), internal: releases("internal") };
  });
}

function describe(release) {
  const rollout = release.userFraction ? ` at ${Math.round(release.userFraction * 100)}%` : "";
  return `${release.name} (versionCode ${release.versionCodes?.join(", ")}, ${release.status}${rollout})`;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      `Usage: pnpm release:android:promote [flags]\n\n` +
        `Publishes ${PACKAGE_NAME} ${VERSION} from Play's internal track to production.\n\n${FLAGS_HELP}`
    );
    return;
  }
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    die(`Play service account not found at ${SERVICE_ACCOUNT_PATH}.`, "It is the key eas submit uses for release:android:play.");
  }

  await authenticate();
  const { language, production, internal } = await readTracks();
  if (production.some((r) => r.name === VERSION && r.status === "completed")) {
    log(`${VERSION} is already in production. Nothing to do.`);
    return;
  }
  const target = internal.find((r) => r.name === VERSION);
  if (!target) {
    die(`No ${VERSION} build on Play's internal track.`, "Run pnpm release:android first; it uploads the bundle there as a draft.");
  }
  const live = production.find((r) => r.status === "completed") ?? production[0];

  log(`Ready to publish ${VERSION} (versionCode ${target.versionCodes.join(", ")}) to production.`);
  log(`Production now: ${live ? describe(live) : "nothing"}`);
  const previousNotes = live?.releaseNotes?.find((n) => n.language === language)?.text;
  const notes = await getNotes(flags, { limit: NOTES_LIMIT, previous: previousNotes });

  console.log(`\nPlan for Google Play (${PACKAGE_NAME}):`);
  console.log(`  - Production: ${live ? `${live.name} -> ` : ""}${VERSION}, full rollout`);
  if (target.status !== "completed") console.log(`  - Internal testing: ${VERSION} ${target.status} -> completed`);
  console.log(
    notes
      ? `  - Release notes (${language}, ${notes.length}/${NOTES_LIMIT} characters):\n${indent(notes, "      ")}`
      : "  - Release notes: not given"
  );
  console.log("  Google reviews the release before it reaches users.");

  if (flags.dryRun) {
    log("Dry run, nothing was changed.");
    return;
  }
  await confirm(flags);

  const release = {
    name: VERSION,
    versionCodes: target.versionCodes,
    status: "completed",
    releaseNotes: [{ language, text: notes }],
  };
  // The notes prompt can outlive the first token, so take a fresh one for the write.
  await authenticate();
  await withEdit(
    async (id) => {
      await api("PUT", `/edits/${id}/tracks/internal`, { track: "internal", releases: [release] });
      await api("PUT", `/edits/${id}/tracks/production`, { track: "production", releases: [release] });
    },
    { commit: true }
  );

  const after = await readTracks();
  const published = after.production.find((r) => r.name === VERSION);
  log(`Done. Production: ${published ? describe(published) : "not found, check the Play Console"}`);
}

main().catch((e) => die(e.message, e.hint));
