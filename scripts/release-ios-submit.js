#!/usr/bin/env node
/**
 * Sends the iOS build that `pnpm release:ios` uploaded to App Review, with release notes.
 *
 * Creates the App Store version (or reuses one still in Prepare for Submission),
 * copying the release type from the previous version, sets What's New, attaches
 * the build once App Store Connect has processed it, and submits it for review.
 * Shows the plan and asks before changing anything.
 *
 * Usage:
 *   pnpm release:ios:submit
 *   pnpm release:ios:submit --notes-file notes.txt --yes   # unattended
 *   pnpm release:ios:submit --dry-run                      # plan only
 *
 * Auth: the App Store Connect API key and config release-ios.js already uses
 * (~/.appstoreconnect/private_keys, ~/.config/dashboarr/ios-release.json).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { FLAGS_HELP, ReleaseError, parseFlags, indent, getNotes, confirm } = require("./release-prompts");

const pkg = require("../package.json");
const VERSION = pkg.version;

const BUNDLE_ID = "com.dashboarr.app";
const KEYS_DIR = path.join(os.homedir(), ".appstoreconnect", "private_keys");
const CONFIG_PATH = path.join(os.homedir(), ".config", "dashboarr", "ios-release.json");
const API = "https://api.appstoreconnect.apple.com";
// App Store Connect's limit for "What's New in This Version".
const NOTES_LIMIT = 4000;
const PROCESSING_POLL_MS = 30 * 1000;
const PROCESSING_TIMEOUT_MS = 45 * 60 * 1000;

// Version states with nothing left to submit.
const SUBMITTED_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "ACCEPTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
]);
// States this script submits from. Anything else (a rejection, say) needs App Store Connect.
const EDITABLE_STATES = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED"]);

const RELEASE_TYPES = {
  AFTER_APPROVAL: "released automatically after approval",
  MANUAL: "released manually after approval",
  SCHEDULED: "released on a scheduled date",
};

function log(msg) {
  console.log(`[release-ios] ${msg}`);
}

function die(msg, hint) {
  console.error(`\n[release-ios] ERROR: ${msg}`);
  if (hint) console.error(`[release-ios] ${hint}`);
  process.exit(1);
}

const b64url = (data) => Buffer.from(data).toString("base64url");
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState;

let config = null;
let privateKey = null;

function loadCredentials() {
  if (!fs.existsSync(CONFIG_PATH)) {
    die(`${CONFIG_PATH} not found.`, "Run pnpm release:ios once first; it stores the key, issuer and team ids there.");
  }
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const keyPath = path.join(KEYS_DIR, `AuthKey_${config.keyId}.p8`);
  if (!fs.existsSync(keyPath)) die(`App Store Connect API key not found at ${keyPath}.`);
  privateKey = fs.readFileSync(keyPath, "utf8");
}

// App Store Connect tokens live at most 20 minutes, so every request signs a fresh one.
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

// Flattens App Store Connect's error body, including the per-field reasons it
// attaches when a submission is blocked (missing screenshots, review info, ...).
function apiErrors(text) {
  try {
    return JSON.parse(text)
      .errors.flatMap((e) => [
        e.detail ?? e.title,
        ...Object.values(e.meta?.associatedErrors ?? {})
          .flat()
          .map((a) => a.detail ?? a.title),
      ])
      .join("; ");
  } catch {
    return text.slice(0, 600);
  }
}

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new ReleaseError(`${method} ${route} failed (${res.status}): ${apiErrors(text)}`);
  return text ? JSON.parse(text) : {};
}

async function findBuild(appId) {
  const { data } = await api(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(VERSION)}&sort=-uploadedDate&limit=1`
  );
  return data[0] ?? null;
}

async function waitForProcessing(appId, build) {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (build.attributes.processingState === "PROCESSING") {
    if (Date.now() > deadline) {
      throw new ReleaseError(
        `Build ${build.attributes.version} is still processing after 45 minutes. Nothing was changed.`,
        "Re-run pnpm release:ios:submit later."
      );
    }
    log(`Build ${build.attributes.version} is still processing, checking again in 30s...`);
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS));
    build = await findBuild(appId);
  }
  if (build.attributes.processingState !== "VALID") {
    throw new ReleaseError(
      `Build ${build.attributes.version} is ${build.attributes.processingState} in App Store Connect.`,
      "Check Apple's email about it, then upload a new build with pnpm release:ios."
    );
  }
  return build;
}

async function localizations(versionId) {
  return (await api("GET", `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`)).data;
}

async function submitForReview(appId, versionId) {
  // A submission still in READY_FOR_REVIEW was never sent (an earlier run stopped
  // halfway), so reuse it rather than open a second one.
  const { data: drafts } = await api("GET", `/v1/reviewSubmissions?filter[app]=${appId}&filter[state]=READY_FOR_REVIEW&limit=1`);
  const reused = drafts[0];
  const submission =
    reused ??
    (
      await api("POST", "/v1/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      })
    ).data;
  try {
    await api("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
  } catch (e) {
    // A reused submission most likely holds this version already; if it doesn't,
    // submitting below fails with App Store Connect's own explanation.
    if (!reused) throw e;
    log(`Kept the existing review submission's items (${e.message})`);
  }
  await api("PATCH", `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } },
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(`Usage: pnpm release:ios:submit [flags]\n\nSubmits ${BUNDLE_ID} ${VERSION} to App Review.\n\n${FLAGS_HELP}`);
    return;
  }
  loadCredentials();

  const app = (await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0];
  if (!app) die(`No app with bundle id ${BUNDLE_ID} in App Store Connect.`);

  const versions = (await api("GET", `/v1/apps/${app.id}/appStoreVersions?limit=10`)).data.sort((a, b) =>
    (b.attributes.createdDate ?? "").localeCompare(a.attributes.createdDate ?? "")
  );
  const current = versions.find((v) => v.attributes.versionString === VERSION);
  const previous = versions.find((v) => v.attributes.versionString !== VERSION);
  if (current && SUBMITTED_STATES.has(stateOf(current))) {
    log(`${VERSION} is already submitted (${stateOf(current)}). Nothing to do.`);
    return;
  }
  if (current && !EDITABLE_STATES.has(stateOf(current))) {
    die(`${VERSION} is in state ${stateOf(current)}.`, "Handle it in App Store Connect.");
  }

  const build = await findBuild(app.id);
  if (!build) {
    die(`No ${VERSION} build in App Store Connect yet.`, "Run pnpm release:ios first, or give a fresh upload a few minutes to show up.");
  }

  const previousLocalizations = previous ? await localizations(previous.id) : [];
  const locales = (current ? await localizations(current.id) : previousLocalizations).map((l) => l.attributes.locale);
  const previousNotes = previousLocalizations.find((l) => l.attributes.locale === app.attributes.primaryLocale)?.attributes.whatsNew;
  const releaseType = current?.attributes.releaseType ?? previous?.attributes.releaseType ?? "AFTER_APPROVAL";
  const processing = build.attributes.processingState === "PROCESSING";

  log(`Ready to submit ${VERSION} (build ${build.attributes.version}) to App Review.`);
  log(`Live now: ${previous ? `${previous.attributes.versionString} (${stateOf(previous)})` : "nothing"}`);
  const notes = await getNotes(flags, { limit: NOTES_LIMIT, previous: previousNotes });

  console.log(`\nPlan for App Store Connect (${app.attributes.name}, ${BUNDLE_ID}):`);
  const releaseText = RELEASE_TYPES[releaseType] ?? releaseType;
  const sameAs = !current && previous ? ` like ${previous.attributes.versionString}` : "";
  console.log(`  - Version ${VERSION}: ${current ? "reuse the one being prepared" : "create it"}, ${releaseText}${sameAs}`);
  console.log(`  - Build: ${build.attributes.version}${processing ? " (still processing, the script waits for it)" : ""}`);
  console.log(
    notes
      ? `  - What's New (${locales.join(", ") || app.attributes.primaryLocale}, ${notes.length}/${NOTES_LIMIT} characters):\n${indent(notes, "      ")}`
      : "  - What's New: not given"
  );
  console.log("  - Submit for App Review");

  if (flags.dryRun) {
    log("Dry run, nothing was changed.");
    return;
  }
  await confirm(flags);

  const ready = await waitForProcessing(app.id, build);
  if (ready.attributes.usesNonExemptEncryption == null) {
    die(
      `Build ${ready.attributes.version} has no export compliance answer. Nothing was changed.`,
      "Answer it in App Store Connect (app.config.ts normally sets ITSAppUsesNonExemptEncryption) and re-run."
    );
  }

  let version = current;
  if (!version) {
    version = (
      await api("POST", "/v1/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: VERSION, releaseType },
          relationships: { app: { data: { type: "apps", id: app.id } } },
        },
      })
    ).data;
    log(`Created version ${VERSION}.`);
  }
  // New versions normally inherit the copyright; submission fails without one.
  if (!version.attributes.copyright && previous?.attributes.copyright) {
    await api("PATCH", `/v1/appStoreVersions/${version.id}`, {
      data: { type: "appStoreVersions", id: version.id, attributes: { copyright: previous.attributes.copyright } },
    });
  }
  for (const loc of await localizations(version.id)) {
    await api("PATCH", `/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: { whatsNew: notes } },
    });
  }
  log("What's New set.");
  await api("PATCH", `/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: ready.id } });
  log(`Build ${ready.attributes.version} attached.`);

  await submitForReview(app.id, version.id);
  const after = (await api("GET", `/v1/appStoreVersions/${version.id}`)).data;
  log(`Done. ${VERSION} is ${stateOf(after)}, ${RELEASE_TYPES[after.attributes.releaseType] ?? after.attributes.releaseType}.`);
}

main().catch((e) => die(e.message, e.hint));
