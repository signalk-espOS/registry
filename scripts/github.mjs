/**
 * The GitHub API, the way both scripts need it.
 *
 * A token is optional -- GitHub allows 60 unauthenticated requests an hour --
 * and is read from GITHUB_TOKEN (Actions) or GH_TOKEN (the gh CLI), because a
 * contributor who exported the one the script did not read ran unauthenticated
 * without knowing it.
 *
 * Being rate limited, or refused the token, is fatal. Every request after it
 * fails the same way, and the callers turn a failed request into a note and
 * carry on -- which, before this, produced an index missing whole projects'
 * releases and exited 0. A partial answer is worse than none here: the index
 * is what boats install from.
 */

export const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
/* Actions sets this; it also points the scripts at a stand-in in tests. */
const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

function fatal(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function rateLimited(response) {
  if (response.status === 429) return true;
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after"))
  );
}

export async function gh(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (TOKEN !== undefined) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${API}${path}`, { headers });
  if (response.ok) return response.json();

  if (rateLimited(response)) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0
      ? ` until ${new Date(reset * 1000).toISOString()}`
      : "";
    fatal(
      `GitHub rate limit reached${when} (GET ${path}). ` +
        (TOKEN === undefined
          ? "No token was set: export GITHUB_TOKEN or GH_TOKEN " +
            "(for example GH_TOKEN=$(gh auth token)) and run again."
          : "Wait for the reset and run again.") +
        " Stopped rather than go on with missing data.",
    );
  }
  if (response.status === 401) {
    fatal(
      `GitHub refused the token (GET ${path} -> HTTP 401). Check GITHUB_TOKEN ` +
        "or GH_TOKEN. Stopped rather than go on with missing data.",
    );
  }
  /* Anything else is about one path -- a repository or branch that does not
   * exist -- and the caller decides what that means. The status travels with
   * the error so it can tell "no such path" from the rest. */
  const error = new Error(`GET ${path} -> HTTP ${response.status}`);
  error.status = response.status;
  throw error;
}
