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

/**
 * Every asset a pattern matches, with the `board` named group it captured.
 *
 * A release may carry one image per board -- the cockpit publishes
 * `p4_cockpit-v1.3.0-7b-ota.bin` and `-x7-ota.bin` -- and those are NOT
 * interchangeable: the wrong one leaves the screen black. So this returns all
 * matches rather than the first, and the caller emits one build per board.
 *
 * The suffix fallback stays for projects with no pattern and older releases
 * that predate the convention, but it only applies when it is unambiguous: if
 * several assets end with the suffix and no pattern told us which board each
 * is for, picking one would be a guess about hardware. That is exactly how a
 * two-board release got indexed as a single unlabelled build, which would have
 * offered an X panel the 7B image.
 */
function matchAssets(assets, pattern, fallbackSuffix, context) {
  if (pattern !== undefined) {
    const re = new RegExp(pattern);
    const hits = [];
    for (const a of assets) {
      const m = re.exec(a.name);
      if (m !== null) hits.push({ asset: a, board: m.groups?.board });
    }
    // Two assets normalising to one board key means find() below would take
    // whichever came first -- the same arbitrary pick this function exists to
    // remove, just one level down. Refuse the lot and say so.
    const seen = new Map();
    for (const h of hits) {
      const key = boardSegmentKey(h.board);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const clashes = [...seen.entries()].filter(([, n]) => n > 1);
    if (clashes.length > 0) {
      warnings.push(
        `${context}: ${clashes
          .map(([k, n]) => `${n} assets match board "${k === NO_BOARD ? "(none)" : k}"`)
          .join(", ")} for ${fallbackSuffix}, so none was indexed -- the pattern ` +
          `cannot tell those images apart`,
      );
      return [];
    }
    if (hits.length > 0) return hits;
  }
  const loose = assets.filter((a) => a.name.endsWith(fallbackSuffix));
  if (loose.length > 1) {
    warnings.push(
      `${context}: ${loose.length} assets end with "${fallbackSuffix}" and the ` +
        `project's pattern did not match them, so none was indexed -- add a ` +
        `"board" named group to assets.${fallbackSuffix.includes("ota") ? "ota" : "merged"} ` +
        `so each image can be tied to the board it was built for`,
    );
    return [];
  }
  return loose.map((a) => ({ asset: a, board: undefined }));
}

/**
 * The grouping key for a captured `board` segment.
 *
 * Trimmed and lower-cased, and the SAME normalisation board ids are resolved
 * with -- otherwise `-7B-ota.bin` and `-7b-merged.bin` group as two builds,
 * each missing half its images, while both resolve to one board id: two builds
 * claiming one board. `\u0000` cannot occur in a filename, so it is a safe
 * stand-in for "this release names no board".
 */
const NO_BOARD = "\u0000none";
function boardSegmentKey(segment) {
  if (segment === undefined) return NO_BOARD;
  const key = String(segment).trim().toLowerCase();
  return key === "" ? NO_BOARD : key;
}

/** The declared board id a captured `board` segment names, or undefined. */
function boardIdFromSegment(project, segment, context) {
  const wanted = boardSegmentKey(segment);
  if (wanted === NO_BOARD) return undefined;
  const hits = (project.boards ?? []).filter(
    (b) => (b.assetSegment ?? "").trim().toLowerCase() === wanted,
  );
  if (hits.length === 1) return hits[0].id;
  warnings.push(
    `${context}: asset names a board segment "${segment}" that ` +
      (hits.length === 0
        ? `no board declares as assetSegment`
        : `${hits.length} boards claim`) +
      `, so the build is not tied to a board and will not be offered over the air`,
  );
  return undefined;
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
    const context = `${project.id} ${release.tag_name}`;
    const otas = matchAssets(assets, project.assets?.ota, "-ota.bin", context);
    const mergeds = matchAssets(
      assets,
      project.assets?.merged,
      "-merged.bin",
      context,
    );
    if (otas.length === 0 && mergeds.length === 0) {
      // Normal for a source-only release; not worth a warning.
      continue;
    }

    // One build per board segment, so a release carrying an image per panel
    // yields one entry each. The key is the raw segment (undefined for a
    // release that names no board), which is what pairs an ota with its merged
    // image.
    const keys = new Set(
      [...otas, ...mergeds].map((h) => boardSegmentKey(h.board)),
    );
    const builds = [];
    for (const key of keys) {
      const seg = key === NO_BOARD ? undefined : key;
      const ota = otas.find((h) => boardSegmentKey(h.board) === key)?.asset;
      const merged = mergeds.find((h) => boardSegmentKey(h.board) === key)
        ?.asset;

      const named = targetFromName(ota?.name ?? merged?.name ?? "");
      let target = named;
      if (target === undefined) {
        if (project.targets.length === 1) {
          target = project.targets[0];
        } else {
          warnings.push(
            `${context}: asset names carry no target and the project declares ` +
              `${project.targets.length}, so the build was skipped rather than guessed`,
          );
          continue;
        }
      }

      builds.push({
        target,
        boardId: boardIdFromSegment(project, seg, context),
        otaUrl: ota?.browser_download_url,
        otaBytes: ota?.size,
        mergedUrl: merged?.browser_download_url,
        mergedBytes: merged?.size,
      });
    }
    if (builds.length === 0) continue;

    resolved.push({
      version: String(release.tag_name).replace(/^v/, ""),
      tag: release.tag_name,
      channel: release.prerelease === true ? "beta" : "stable",
      publishedAt: release.published_at,
      notes: summarise(release.body),
      notesUrl: release.html_url,
      builds,
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
