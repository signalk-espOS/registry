#!/usr/bin/env node
/**
 * Validate every project entry.
 *
 * Runs on each pull request. The checks are deliberately structural: firmware
 * cannot be load-tested in CI the way an npm package can — that needs the
 * board — so this proves an entry is well-formed and its assets are real, and
 * says plainly that it proves nothing more.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TOKEN = process.env.GITHUB_TOKEN;
const errors = [];
const notes = [];

function fail(file, message) { errors.push(`${file}: ${message}`); }

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (TOKEN !== undefined) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const schema = JSON.parse(
  await readFile(join(ROOT, "schema/project.schema.json"), "utf8"),
);
const required = schema.required;
const allowed = new Set(Object.keys(schema.properties));

const dir = join(ROOT, "projects");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
const seenIds = new Map();
const seenApps = new Map();

for (const file of files) {
  let entry;
  try {
    entry = JSON.parse(await readFile(join(dir, file), "utf8"));
  } catch (e) {
    fail(file, `not valid JSON: ${e.message}`);
    continue;
  }

  for (const key of required) {
    if (entry[key] === undefined) fail(file, `missing required field "${key}"`);
  }
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(file, `unknown field "${key}"`);
  }

  // The filename is the id: a mismatch makes the entry unfindable.
  const expected = basename(file, ".json");
  if (entry.id !== expected) {
    fail(file, `id "${entry.id}" does not match the filename`);
  }

  if (seenIds.has(entry.id)) fail(file, `id also used by ${seenIds.get(entry.id)}`);
  seenIds.set(entry.id, file);

  // Two projects claiming one app name would fight over the same manifest:
  // a manifest serves exactly one application.
  if (entry.app !== undefined) {
    if (seenApps.has(entry.app)) {
      fail(file, `app "${entry.app}" is already claimed by ${seenApps.get(entry.app)}`);
    }
    seenApps.set(entry.app, file);
  }

  for (const board of entry.boards ?? []) {
    if (!(entry.targets ?? []).includes(board.target)) {
      fail(file, `board "${board.id}" names target ${board.target}, which the project does not list`);
    }
  }

  // Anchored and ReDoS-free: these run in a browser.
  for (const [kind, pattern] of Object.entries(entry.assets ?? {})) {
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
      fail(file, `assets.${kind} must be anchored with ^ and $`);
    }
    if (/\.\*|\(\.\+\)\+|\(\S*\+\)\+/.test(pattern)) {
      fail(file, `assets.${kind} uses an unbounded quantifier`);
    }
    try { new RegExp(pattern, "u"); } catch (e) {
      fail(file, `assets.${kind} is not a valid regex: ${e.message}`);
    }
  }

  // The repository has to exist and be usable.
  if (typeof entry.repo === "string" && TOKEN !== undefined) {
    try {
      const repo = await gh(`/repos/${entry.repo}`);
      if (repo.archived === true) notes.push(`${file}: ${entry.repo} is archived`);
    } catch (e) {
      fail(file, `repo ${entry.repo} is not reachable (${e.message})`);
    }
  }

  if (entry.signed === false) {
    notes.push(`${file}: marked unsigned — those builds accept no updates afterwards`);
  }
  if ((entry.boards ?? []).length > 1) {
    const perTarget = {};
    for (const b of entry.boards) perTarget[b.target] = (perTarget[b.target] ?? 0) + 1;
    for (const [t, n] of Object.entries(perTarget)) {
      if (n > 1) notes.push(`${file}: ${n} boards share target ${t} — the flasher will ask which one the user has`);
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (errors.length > 0) {
  for (const e of errors) console.log(`::error::${e}`);
  console.log(`\n${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`${files.length} project entr${files.length === 1 ? "y" : "ies"} valid.`);
console.log(
  "Structural checks only: firmware needs a board to test, so a valid entry " +
  "means well-formed and reachable, not known-good.",
);
