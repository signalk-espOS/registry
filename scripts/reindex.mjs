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
import { gh, TOKEN } from "./github.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
if (TOKEN === undefined) {
  console.log(
    "note: no GITHUB_TOKEN or GH_TOKEN; unauthenticated, 60 requests an hour. " +
      "It stops rather than write a partial index if it runs out.",
  );
}

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

/**
 * The asset's SHA-256 as lowercase hex, from the digest GitHub computes at
 * upload. The device verifies a manifest's sha256 before it writes a byte, so
 * this is the checksum the plugin forwards. Older assets carry no digest, and
 * an absent checksum is better than one computed from a second download that
 * might not be the same file.
 */
function sha256Of(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest ?? ""));
  return m === null ? undefined : m[1].toLowerCase();
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

/* ------------------------------------------------- espOS version per release
 *
 * Which espOS a firmware was built against is worth knowing: it is what decides
 * whether a device gets a fix that landed in the runtime rather than in the
 * application. Nothing in a release records it -- the assets are bare .bin
 * files -- but a consumer pins espOS as a submodule, and a submodule pin IS the
 * version, exactly, at whatever tag the release was cut from.
 *
 * Reading it that way means no firmware CI change and it works retroactively
 * for releases already published. Verified against real releases:
 * espos-ble-gateway v0.3.1 pins 2b4fdc86 = espOS v0.10.3, v0.3.0 = v0.10.2.
 *
 * An EXACT sha-to-tag match, never `git describe`-style nearest-tag guessing: a
 * consumer that pinned an untagged commit is between releases, and saying
 * "v0.10.3" about a commit that is not v0.10.3 would be worse than saying
 * nothing. Unmatched simply omits the field.
 */
const ESPOS_REPO = "signalk-espOS/espOS";

/**
 * Compare dotted numeric versions.
 *
 * Deliberately small: its only caller filters to /^[0-9]+(\.[0-9]+)*$/ first,
 * so there are no prerelease suffixes to order and none of espOS's own
 * comparison rules are needed. A full implementation here would be a third copy
 * of logic that already exists in two places and would have to stay in step
 * with the device for no benefit.
 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** sha -> tag for every espOS tag, fetched once. */
let esposTagsBySha;

async function esposTags() {
  if (esposTagsBySha !== undefined) return esposTagsBySha;
  esposTagsBySha = new Map();
  try {
    /* Tags, not releases: a tag always exists for a release, and this is one
     * request per 100 rather than one per release. */
    for (let page = 1; page <= 5; page++) {
      const tags = await gh(`/repos/${ESPOS_REPO}/tags?per_page=100&page=${page}`);
      for (const t of tags) esposTagsBySha.set(t.commit?.sha, t.name);
      if (tags.length < 100) break;
    }
  } catch (error) {
    warnings.push(`could not list ${ESPOS_REPO} tags (${error.message}); no espOS versions will be recorded`);
  }
  return esposTagsBySha;
}

/** The espOS version a release was built against, or undefined. */
async function esposVersionAt(project, tag) {
  const path = project.esposSubmodule ?? "espos";
  let sha;
  try {
    /* Encode each SEGMENT, not the whole path: the schema allows a nested
     * `esposSubmodule` like "libs/espos", and encoding it wholesale turns the
     * separator into %2F, which the contents API answers 404 to. A 404 is
     * treated as "no submodule here", so the mistake would be invisible --
     * that project would simply never record an espOS version. Same care the
     * web-asset URLs already take a few lines below. */
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const entry = await gh(
      `/repos/${project.repo}/contents/${encodedPath}?ref=${encodeURIComponent(tag)}`,
    );
    /* A submodule reads back as type "submodule" and its sha is the pinned
     * commit. Anything else means the path is not what we assumed, and a
     * directory's sha would be a tree, never an espOS commit. */
    if (entry?.type !== "submodule") return undefined;
    sha = entry.sha;
  } catch (error) {
    if (error.status === 404) {
      /* No such path at that tag: an older release from before the submodule
       * existed, or a project that consumes espOS some other way. Not a
       * warning -- this is optional metadata and a missing field says so. */
      return undefined;
    }
    /* Anything else -- a 403 rate limit above all -- would otherwise omit the
     * version from EVERY release and read as "no project pins espOS", which is
     * a wrong index rather than an incomplete one. Say so. */
    warnings.push(
      `${project.id} ${tag}: could not read the espOS pin (${error.message}); ` +
        `no espOS version recorded for it`,
    );
    return undefined;
  }
  const name = (await esposTags()).get(sha);
  return name === undefined ? undefined : String(name).replace(/^v/, "");
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

  // Which tags the mirror branch actually holds. A webAssetsBranch is pruned --
  // it keeps the newest few tags -- and it starts existing at some point in a
  // project's life, so older releases have no copy there. Rewriting a release URL
  // into that branch without checking produces a link that 404s, and the web
  // flasher offers several versions back (it is how a user rolls a device back),
  // so those dead links would be reachable rather than theoretical.
  //
  // One listing per project, not a request per asset: this is the branch's root,
  // whose entries are the tag directories.
  // Keyed `<tag>/<asset name>`, so a tag that is present but INCOMPLETE cannot
  // advertise the assets it is missing. Listing the branch root alone would only
  // prove the directory exists; a mirror is a third party's workflow publishing on
  // its own schedule, so "the directory is there" does not imply "every asset is".
  let mirrored;
  if (project.webAssetsBranch !== undefined) {
    try {
      const ref = encodeURIComponent(project.webAssetsBranch);
      const entries = await gh(`/repos/${project.repo}/contents?ref=${ref}`);
      mirrored = new Set();
      for (const dir of entries.filter((e) => e.type === "dir")) {
        // One request per tag directory. A mirror keeps only the newest few tags,
        // so this is a handful of calls, and the alternative -- trusting the
        // directory -- is what puts a download in the flasher that 404s.
        const files = await gh(
          `/repos/${project.repo}/contents/${encodeURIComponent(dir.name)}?ref=${ref}`,
        );
        for (const f of files.filter((e) => e.type === "file")) {
          mirrored.add(`${dir.name}/${f.name}`);
        }
      }
    } catch (error) {
      // Distinguish "no such branch" from "could not ask". A missing branch means
      // no release is mirrored yet, which is a normal state before the first
      // release that publishes one. Any other failure leaves `mirrored`
      // undefined, and webUrl below then emits nothing rather than guessing --
      // omitting a usable URL degrades the flasher, inventing a dead one breaks it.
      mirrored = undefined;
      warnings.push(
        `${project.id}: could not list ${project.webAssetsBranch} ` +
          `(${error.message}); no browser-readable URLs will be recorded`,
      );
    }
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
    // Consumers decide "USB only" per build, so a project-wide `signed: false`
    // is copied onto every build. Release notes are deliberately not read for
    // this: their "Unsigned build" warning survives a signed re-release.
    const unsigned = project.signed === false;
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

      // Release assets outlive a project's support claim: a published release is
      // immutable, while `targets` is the current answer to what the firmware runs
      // on. So `targets` decides, and an undeclared target is skipped -- otherwise
      // dropping one would leave its images reachable in the flasher, which is the
      // opposite of what dropping it meant.
      if (!project.targets.includes(target)) {
        warnings.push(
          `${context}: ${target} build present in the release but not in the ` +
            `project's targets, so it was not indexed`,
        );
        continue;
      }

      // A URL a BROWSER may fetch, when the project publishes one.
      //
      // browser_download_url is misnamed for our purposes: GitHub serves
      // release downloads with no Access-Control-Allow-Origin, so a web page
      // cannot read them at all. raw.githubusercontent does send it, so a
      // project that mirrors its images to a branch gets a second URL that
      // the web flasher can actually use. The release URL stays as-is: the
      // Signal K plugin fetches server-side and is unaffected by CORS.
      const webUrl = (asset) => {
        if (project.webAssetsBranch === undefined || asset === undefined) {
          return undefined;
        }
        // Only when the mirror actually holds THIS FILE, not merely its tag.
        if (
          mirrored === undefined ||
          !mirrored.has(`${release.tag_name}/${asset.name}`)
        ) {
          return undefined;
        }
        // Encode each component. A tag or asset name may legitimately contain
        // `#` or `?`, and unencoded either one truncates the path: `fw#1.bin`
        // becomes `fw` with `#1.bin` as a fragment, which 404s and reads as a
        // missing file rather than a malformed URL. The branch may contain
        // slashes (`release/assets`), so its separators are preserved while
        // its segments are encoded.
        const branch = project.webAssetsBranch
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        return (
          `https://raw.githubusercontent.com/${project.repo}/` +
          `${branch}/${encodeURIComponent(release.tag_name)}/` +
          encodeURIComponent(asset.name)
        );
      };

      builds.push({
        target,
        boardId: boardIdFromSegment(project, seg, context),
        otaUrl: ota?.browser_download_url,
        otaWebUrl: webUrl(ota),
        otaBytes: ota?.size,
        otaSha256: sha256Of(ota),
        mergedUrl: merged?.browser_download_url,
        mergedWebUrl: webUrl(merged),
        mergedBytes: merged?.size,
        mergedSha256: sha256Of(merged),
        ...(unsigned ? { unsigned: true } : {}),
      });
    }
    if (builds.length === 0) continue;

    resolved.push({
      version: String(release.tag_name).replace(/^v/, ""),
      tag: release.tag_name,
      espos: await esposVersionAt(project, release.tag_name),
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

/* The newest espOS, so a consumer can say "this build is a release behind"
 * without fetching anything itself -- a flasher talking to a blank board over
 * USB has no other way to know, and an unflashed board cannot be asked. */
await esposTags(); /* explicitly, not as a side effect of resolving releases:
                    * a registry where no project pins espOS as a submodule
                    * would otherwise report no latest version at all. */
const esposLatest = (() => {
  const names = [...(esposTagsBySha?.values() ?? [])]
    .map((n) => String(n).replace(/^v/, ""))
    /* Releases only: a tag like "v0.1.0-rc1" is not what a consumer should be
     * told it is behind. */
    .filter((n) => /^[0-9]+(\.[0-9]+)*$/.test(n));
  names.sort(compareVersions);
  return names[names.length - 1];
})();

const index = {
  schema: 1,
  updated: new Date().toISOString(),
  ...(esposLatest === undefined ? {} : { esposLatest }),
  projects,
};
await writeFile(join(ROOT, "index.json"), JSON.stringify(index, null, 2) + "\n");

const withFirmware = projects.filter((p) => (p.releases ?? []).length > 0);
console.log(
  `index.json: ${projects.length} project(s), ${withFirmware.length} with firmware`,
);
/* What each entry resolved to, so a contributor sees their own project's result
 * without reading JSON: a project with releases but no builds, or builds but no
 * browser-readable copy, is the usual first surprise. */
for (const p of projects) {
  const releases = p.releases ?? [];
  const builds = releases.flatMap((r) => r.builds ?? []);
  const web = builds.filter((b) => b.mergedWebUrl !== undefined).length;
  const espos = releases.filter((r) => r.espos !== undefined).length;
  console.log(
    `  ${p.id}: ${releases.length} release(s), ${builds.length} build(s), ` +
      `${web} flashable in a browser, espOS version known for ${espos}`,
  );
}
for (const warning of warnings) console.log(`  note: ${warning}`);
