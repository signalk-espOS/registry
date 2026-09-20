#!/usr/bin/env node
/**
 * Build index.json from the project entries plus their GitHub releases.
 *
 * The plugin reads the generated index and nothing else, so it makes exactly
 * one unauthenticated request to raw.githubusercontent.com — no GitHub API, no
 * token, no rate limit on a boat. Resolving releases is this script's job, run
 * nightly and on merge.
 *
 * Asset naming is not assumed. The cockpit publishes
 * `p4_cockpit-v1.2.0-ota.bin` with no target segment, and its older releases
 * predate the convention entirely, so each project may declare anchored
 * patterns. Where a name carries no target and the project declares exactly
 * one, that is unambiguous; where it carries none and the project has several,
 * the build is skipped and reported rather than guessed — a wrong target is an
 * image the device rejects only after the whole download.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TOKEN = process.env.GITHUB_TOKEN;

const KNOWN_TARGETS = [
  "esp32c61",
  "esp32c2",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32h2",
  "esp32p4",
  "esp32s2",
  "esp32s3",
  "esp32",
];

const warnings = [];

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (TOKEN !== undefined) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}`);
  }
  return response.json();
}

/** A target named in an asset filename, or undefined rather than a guess. */
function targetFromName(name) {
  const lower = name.toLowerCase();
  for (const target of KNOWN_TARGETS) {
    if (new RegExp(`(^|[^a-z0-9])${target}([^a-z0-9]|$)`).test(lower)) {
      return target;
    }
  }
  return undefined;
}

/**
 * One line of prose from a release body.
 *
 * A device stores 127 bytes of notes, and a raw GitHub body is markdown —
 * headings, compare links, bullet lists. Unprocessed it arrives as a truncated
 * URL. Skips headings, bare version lines and release-please section labels.
 */
const SECTION_LABELS = new Set([
  "added",
  "changed",
  "fixed",
  "removed",
  "deprecated",
  "security",
  "features",
  "bug fixes",
  "bugfixes",
  "performance improvements",
  "miscellaneous chores",
  "documentation",
  "what's changed",
  "breaking changes",
]);

function summarise(body) {
  if (typeof body !== "string") return "";
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "") continue;
    line = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line === "" || /^v?\d+(\.\d+)+\s*(\(.*\))?$/.test(line)) continue;
    if (SECTION_LABELS.has(line.toLowerCase().replace(/:$/, ""))) continue;
    return line;
  }
  return "";
}

function matchAsset(assets, pattern, fallbackSuffix) {
  if (pattern !== undefined) {
    const re = new RegExp(pattern);
    const hit = assets.find((a) => re.test(a.name));
    if (hit !== undefined) return hit;
  }
  return assets.find((a) => a.name.endsWith(fallbackSuffix));
}

async function resolveProject(project) {
  let releases;
  try {
    releases = await gh(`/repos/${project.repo}/releases?per_page=30`);
  } catch (error) {
    warnings.push(`${project.id}: ${error.message}`);
    return { ...project, releases: [] };
  }

  const resolved = [];
  for (const release of releases) {
    if (release.draft === true) continue;
    const assets = release.assets ?? [];
    const ota = matchAsset(assets, project.assets?.ota, "-ota.bin");
    const merged = matchAsset(assets, project.assets?.merged, "-merged.bin");
    if (ota === undefined && merged === undefined) {
      // Normal for a source-only release; not worth a warning.
      continue;
    }

    const named = targetFromName(ota?.name ?? merged?.name ?? "");
    let target = named;
    if (target === undefined) {
      if (project.targets.length === 1) {
        target = project.targets[0];
      } else {
        warnings.push(
          `${project.id} ${release.tag_name}: asset names carry no target and ` +
            `the project declares ${project.targets.length}, so the build was ` +
            `skipped rather than guessed`,
        );
        continue;
      }
    }

    resolved.push({
      version: String(release.tag_name).replace(/^v/, ""),
      tag: release.tag_name,
      channel: release.prerelease === true ? "beta" : "stable",
      publishedAt: release.published_at,
      notes: summarise(release.body),
      notesUrl: release.html_url,
      builds: [
        {
          target,
          otaUrl: ota?.browser_download_url,
          otaBytes: ota?.size,
          mergedUrl: merged?.browser_download_url,
          mergedBytes: merged?.size,
        },
      ],
    });
  }

  if (resolved.length === 0) {
    warnings.push(
      `${project.id}: no release publishes firmware assets yet — the entry is ` +
        `kept, since that is the normal state of a new project`,
    );
  }
  return { ...project, releases: resolved };
}

const dir = join(ROOT, "projects");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
const projects = [];
for (const file of files) {
  const project = JSON.parse(await readFile(join(dir, file), "utf8"));
  projects.push(await resolveProject(project));
}

const index = {
  schema: 1,
  updated: new Date().toISOString(),
  projects,
};
await writeFile(join(ROOT, "index.json"), JSON.stringify(index, null, 2) + "\n");

const withFirmware = projects.filter((p) => (p.releases ?? []).length > 0);
console.log(
  `index.json: ${projects.length} project(s), ${withFirmware.length} with firmware`,
);
for (const warning of warnings) console.log(`  note: ${warning}`);
