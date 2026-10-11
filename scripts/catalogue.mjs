/**
 * The board and use-case catalogue: boards/<id>.json and usecases/<id>.json.
 *
 * Projects describe images; the catalogue describes hardware and the jobs an
 * owner wants done. Shared by validate.mjs and reindex.mjs so the two cannot
 * disagree about what an entry means.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every `<dir>/*.json`, parsed, with parse failures reported rather than thrown. */
async function loadDir(dir, fail) {
  let files;
  try {
    files = (await readdir(join(ROOT, dir))).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const file of files.sort()) {
    const where = `${dir}/${file}`;
    try {
      const entry = JSON.parse(await readFile(join(ROOT, dir, file), "utf8"));
      out.push({ where, id: basename(file, ".json"), entry });
    } catch (e) {
      fail(where, `not valid JSON: ${e.message}`);
    }
  }
  return out;
}

async function loadSchema(name) {
  return JSON.parse(await readFile(join(ROOT, "schema", name), "utf8"));
}

/**
 * Required fields, unknown fields, enums and patterns the schema states at the
 * top level and one level down. Not a full JSON Schema validator: the registry
 * deliberately has no dependencies, and these are the mistakes people make.
 */
export function checkShape(where, entry, schema, fail) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(where, "must be a JSON object");
    return;
  }
  for (const key of schema.required ?? []) {
    if (entry[key] === undefined) fail(where, `missing required field "${key}"`);
  }
  for (const [key, value] of Object.entries(entry)) {
    const prop = schema.properties?.[key];
    if (prop === undefined) {
      if (schema.additionalProperties === false) fail(where, `unknown field "${key}"`);
      continue;
    }
    checkValue(where, key, value, prop, fail);
  }
}

function checkValue(where, key, value, prop, fail) {
  if (value === null) {
    fail(where, `"${key}" is null; leave the field out instead`);
    return;
  }
  const type = Array.isArray(value) ? "array" : typeof value;
  const want = prop.type === "integer" ? "number" : prop.type === "object" ? "object" : prop.type;
  if (want !== undefined && type !== want) {
    fail(where, `"${key}" must be ${prop.type === "array" ? "an array" : `a ${prop.type}`}`);
    return;
  }
  if (prop.type === "integer" && !Number.isInteger(value)) fail(where, `"${key}" must be a whole number`);
  if (prop.minimum !== undefined && value < prop.minimum) fail(where, `"${key}" is below ${prop.minimum}`);
  if (prop.maximum !== undefined && value > prop.maximum) fail(where, `"${key}" is above ${prop.maximum}`);
  if (prop.enum !== undefined && !prop.enum.includes(value)) {
    fail(where, `"${key}" is "${value}", not one of ${prop.enum.join(", ")}`);
  }
  if (prop.pattern !== undefined && typeof value === "string" && !new RegExp(prop.pattern, "u").test(value)) {
    fail(where, `"${key}" does not match ${prop.pattern}`);
  }
  if (typeof value === "string") {
    if (prop.minLength !== undefined && value.length < prop.minLength) fail(where, `"${key}" is too short`);
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      fail(where, `"${key}" is ${value.length} characters, over ${prop.maxLength}`);
    }
  }
  if (prop.type === "array") {
    if (prop.uniqueItems && new Set(value).size !== value.length) fail(where, `"${key}" repeats an item`);
    if (prop.maxItems !== undefined && value.length > prop.maxItems) fail(where, `"${key}" has over ${prop.maxItems} items`);
    if (prop.minItems !== undefined && value.length < prop.minItems) fail(where, `"${key}" needs at least ${prop.minItems} item(s)`);
    if (prop.items !== undefined) value.forEach((v, i) => checkValue(where, `${key}[${i}]`, v, prop.items, fail));
  }
  if (prop.type === "object" && prop.properties !== undefined) checkShape(`${where} ${key}`, value, prop, fail);
  if (prop.type === "object" && typeof prop.additionalProperties === "object") {
    for (const [k, v] of Object.entries(value)) checkValue(where, `${key}.${k}`, v, prop.additionalProperties, fail);
  }
}

/**
 * Load and check the catalogue against the projects that refer to it.
 *
 * `projects` are the parsed project entries. Returns the boards and use cases
 * keyed by id; problems go to `fail`, softer findings to `note`.
 */
export async function loadCatalogue(projects, fail, note = () => {}) {
  const boardSchema = await loadSchema("board.schema.json");
  const useCaseSchema = await loadSchema("usecase.schema.json");
  const boards = new Map();
  const useCases = new Map();

  for (const { where, id, entry } of await loadDir("boards", fail)) {
    checkShape(where, entry, boardSchema, fail);
    if (entry.id !== id) fail(where, `id "${entry.id}" does not match the filename`);
    boards.set(entry.id, entry);
  }
  for (const { where, id, entry } of await loadDir("usecases", fail)) {
    checkShape(where, entry, useCaseSchema, fail);
    if (entry.id !== id) fail(where, `id "${entry.id}" does not match the filename`);
    useCases.set(entry.id, entry);
  }

  const projectIds = new Set(projects.map((p) => p.id));
  for (const project of projects) {
    const where = `projects/${project.id}.json`;
    for (const b of project.boards ?? []) {
      const own = boards.get(b.id);
      if (b.name === undefined && own === undefined) {
        fail(where, `board "${b.id}" has no name and no boards/${b.id}.json to take one from`);
      }
      // A board on the wrong chip would be offered an image it rejects only
      // after the whole download.
      for (const target of runsOn(b)) {
        const board = boards.get(target);
        if (board === undefined) {
          if (b.runsOn !== undefined) fail(where, `board "${b.id}" runs on "${target}", which has no boards/${target}.json`);
          continue;
        }
        if (board.target !== b.target) {
          fail(where, `board "${b.id}" is ${b.target} but boards/${target}.json is ${board.target}`);
        }
        if (
          b.flashMinBytes !== undefined &&
          board.flashBytes !== undefined &&
          board.flashBytes < b.flashMinBytes
        ) {
          fail(where, `board "${b.id}" needs ${b.flashMinBytes} bytes of flash, but boards/${target}.json has ${board.flashBytes}`);
        }
      }
    }
  }

  for (const [id, uc] of useCases) {
    const where = `usecases/${id}.json`;
    for (const p of uc.projects ?? []) {
      if (!projectIds.has(p)) fail(where, `project "${p}" has no projects/${p}.json`);
    }
    // A reason recommends a board for this job, so the job's firmware has to
    // run on it: otherwise the owner buys a board and finds nothing to flash.
    const served = new Set(
      projects
        .filter((p) => (uc.projects ?? []).includes(p.id))
        .flatMap((p) => (p.boards ?? []).flatMap(runsOn)),
    );
    for (const b of Object.keys(uc.reasons ?? {})) {
      if (!boards.has(b)) fail(where, `reasons names "${b}", which has no boards/${b}.json`);
      else if (!served.has(b)) fail(where, `reasons recommends "${b}", but none of this use case's projects runs on it`);
    }
    if ((uc.projects ?? []).length === 0) note(`${where}: no project does this yet; the flasher shows it as coming`);
  }

  return { boards, useCases };
}

/** The catalogue boards a project's board entry runs on. */
export function runsOn(projectBoard) {
  return projectBoard.runsOn ?? [projectBoard.id];
}
