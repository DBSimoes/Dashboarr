/**
 * Shared prompts for the store publish scripts (release-android-promote.js and
 * release-ios-submit.js): flag parsing, the release-notes prompt and the final
 * confirmation. Every interactive step has a flag, so the same scripts also run
 * unattended with --notes-file + --yes.
 */

const fs = require("fs");
const readline = require("readline");

const FLAGS_HELP = `Flags:
  --notes-file <path>  Read the release notes from a file instead of prompting
  --yes, -y            Skip the confirmation prompt
  --dry-run            Show the plan and stop without changing anything
  --help, -h           Show this help`;

class ReleaseError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function parseFlags(argv) {
  const flags = { notesFile: null, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--notes-file") {
      flags.notesFile = argv[++i];
      if (!flags.notesFile) throw new ReleaseError("--notes-file needs a path.");
    } else if (arg.startsWith("--notes-file=")) {
      flags.notesFile = arg.slice("--notes-file=".length);
    } else if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else {
      throw new ReleaseError(`Unknown flag: ${arg}`, "Run with --help to see the flags.");
    }
  }
  return flags;
}

function indent(text, prefix = "    ") {
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

function openPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Without a listener readline swallows Ctrl-C (it only pauses the stream).
  // Prompts only run before anything is changed, so aborting here is always safe.
  rl.on("SIGINT", () => {
    rl.close();
    console.log("\nAborted, nothing was changed.");
    process.exit(130);
  });
  return rl;
}

// Reads lines until one contains only ".". Release notes have blank lines between
// sections, so an empty line can't be the terminator. Resolves null when input
// closes first (Ctrl-D), since nothing after that could be read either.
function readBlock() {
  return new Promise((resolve) => {
    const rl = openPrompt();
    const lines = [];
    let finished = false;
    rl.on("line", (line) => {
      if (line.trim() === ".") {
        finished = true;
        rl.close();
      } else {
        lines.push(line);
      }
    });
    rl.on("close", () => resolve(finished ? lines.join("\n").trim() : null));
  });
}

function checkNotes(text, limit) {
  if (!text) return "The release notes are empty.";
  if (text.length > limit) return `The release notes are ${text.length} characters, the limit is ${limit}.`;
  return null;
}

/**
 * Returns the release notes from --notes-file, or asks for them, showing the
 * previous release's notes as a reference for the format. Returns null only for
 * a --dry-run without a terminal to ask in.
 */
async function getNotes(flags, { limit, previous }) {
  if (flags.notesFile) {
    if (!fs.existsSync(flags.notesFile)) throw new ReleaseError(`Notes file not found: ${flags.notesFile}`);
    const text = fs.readFileSync(flags.notesFile, "utf8").trim();
    const problem = checkNotes(text, limit);
    if (problem) throw new ReleaseError(`${flags.notesFile}: ${problem}`);
    return text;
  }
  if (!process.stdin.isTTY) {
    if (flags.dryRun) return null;
    throw new ReleaseError(
      "No terminal to ask for the release notes in.",
      "Pass --notes-file <path> (plus --yes to skip the confirmation)."
    );
  }
  if (previous) {
    console.log("\nPrevious release notes, for reference:\n");
    console.log(indent(previous));
  }
  for (;;) {
    console.log(`\nType or paste the release notes (max ${limit} characters).`);
    console.log('Finish with a line containing only "." (Ctrl-C aborts):\n');
    const text = await readBlock();
    if (text === null) throw new ReleaseError("Input closed before the release notes were finished.");
    const problem = checkNotes(text, limit);
    if (!problem) return text;
    console.log(`\n${problem} Try again.`);
  }
}

async function confirm(flags) {
  if (flags.yes) return;
  if (!process.stdin.isTTY) {
    throw new ReleaseError("No terminal to confirm in.", "Re-run with --yes once the plan above looks right.");
  }
  const rl = openPrompt();
  const answer = await new Promise((resolve) => {
    rl.question("\nProceed? [y/N] ", resolve);
    rl.on("close", () => resolve(""));
  });
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Aborted, nothing was changed.");
    process.exit(0);
  }
}

module.exports = { FLAGS_HELP, ReleaseError, parseFlags, indent, getNotes, confirm };
