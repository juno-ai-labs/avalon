/**
 * The operator site's HTML.
 *
 * Server-rendered, no client bundle, no framework on the page. The site exists
 * to be readable during an incident, which is exactly when a build step, a CDN
 * dependency, or a hydration failure is least welcome. `hono/html` escapes
 * every interpolation, so object names and failure text — the two fields that
 * come from outside this Worker — cannot become markup.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  MigrationEvent,
  MigrationsOverview,
  ObjectDetail,
  ObjectQuery,
  ObjectStatus,
  RegistryOverview,
  TrackedObject,
  TrackedObjectPage,
} from "./protocol";

const STATUS_ORDER: ObjectStatus[] = [
  "failed",
  "behind",
  "unreported",
  "current",
  "not_reporting",
  "empty",
  "absent",
];

const STATUS_LABEL: Record<ObjectStatus, string> = {
  failed: "Failed",
  behind: "Behind",
  unreported: "Unreported",
  current: "Current",
  not_reporting: "Not reporting",
  empty: "Empty",
  absent: "Absent",
};

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #dfe3e8;
    --text: #16191d;
    --muted: #5c6570;
    --accent: #2b5fd9;
    --failed: #b3261e;
    --failed-bg: #fbe9e7;
    --behind: #8a5a00;
    --behind-bg: #fdf3e0;
    --unreported: #4a4f57;
    --unreported-bg: #eceef1;
    --current: #1c6b45;
    --current-bg: #e6f4ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101317;
      --panel: #171b21;
      --border: #2a3038;
      --text: #e7eaee;
      --muted: #99a1ab;
      --accent: #7aa2ff;
      --failed: #ff9b90;
      --failed-bg: #3a1f1c;
      --behind: #f0c078;
      --behind-bg: #382a15;
      --unreported: #b6bcc4;
      --unreported-bg: #262b32;
      --current: #7fd6a6;
      --current-bg: #17301f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
    justify-content: space-between;
    padding: 18px 24px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  header h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  header nav a { margin-right: 16px; }
  header .who { color: var(--muted); font-size: 13px; }
  main { padding: 24px; max-width: 1440px; margin: 0 auto; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em;
       color: var(--muted); margin: 28px 0 10px; }
  section:first-of-type h2 { margin-top: 0; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
           overflow: hidden; }
  .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 16px; display: block; }
  .tile .n { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .tile .k { color: var(--muted); font-size: 13px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border);
           white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase;
       letter-spacing: 0.05em; }
  tr:last-child td { border-bottom: none; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
          font-size: 12px; font-weight: 600; }
  .pill.failed { color: var(--failed); background: var(--failed-bg); }
  .pill.behind { color: var(--behind); background: var(--behind-bg); }
  .pill.unreported, .pill.empty, .pill.absent, .pill.not_reporting, .pill.retired {
    color: var(--unreported); background: var(--unreported-bg); }
  .pill.current, .pill.applied { color: var(--current); background: var(--current-bg); }
  .muted { color: var(--muted); }
  /* A retired namespace or component is kept for the record, not for the
     dashboard's headline: legible, obviously not live. */
  tr.retired td { opacity: 0.55; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 14px; }
  .filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px;
                   color: var(--muted); }
  .filters select, .filters input, .filters button {
    font: inherit; padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  .filters button { cursor: pointer; font-weight: 600; }
  .pager { display: flex; gap: 14px; align-items: center; margin-top: 14px; color: var(--muted);
           font-size: 13px; }
  .empty { padding: 22px; color: var(--muted); }
  .failure { color: var(--failed); white-space: normal; max-width: 520px; }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px;
             margin: 0; padding: 16px; }
  dl.facts dt { color: var(--muted); font-size: 13px; }
  dl.facts dd { margin: 0; }
  .banner { border-radius: 10px; padding: 14px 16px; margin-bottom: 20px;
            background: var(--behind-bg); color: var(--behind); }
  .banner.banner-bad { background: var(--failed-bg); color: var(--failed); }
  /* The run an operator has just started, so the redirect lands on something
     they can see rather than on a list they have to search. */
  tr.highlight td { background: var(--behind-bg); }
  .run-panel { padding: 16px; }
  .run-panel form { margin-bottom: 0; }
  /* var(--panel) rather than white: the accent inverts between the two schemes,
     so a fixed foreground is legible against one of them and washed out
     against the other. */
  .run-panel button { background: var(--accent); color: var(--panel); border-color: transparent; }
  .note { color: var(--muted); font-size: 13px; margin: 12px 0 0; max-width: 72ch; }
`;

export function layout(
  title: string,
  principal: string | null,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title} · Avalon migrations</title>
    <style>${raw(STYLES)}</style>
  </head>
  <body>
    <header>
      <h1>Avalon Durable Object migrations</h1>
      <nav>
        <a href="/">Overview</a>
        <a href="/objects">Objects</a>
        <a href="/objects?status=failed">Failures</a>
        <a href="/migrations">Force a migration</a>
      </nav>
      <span class="who">${principal ?? ""}</span>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}

export function refusalPage(message: string): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not authorized · Avalon migrations</title>
    <style>${raw(STYLES)}</style>
  </head>
  <body>
    <main>
      <div class="panel" style="padding:24px">
        <h1 style="margin-top:0;font-size:18px">Not authorized</h1>
        <p class="muted">${message}</p>
      </div>
    </main>
  </body>
</html>`;
}

export function overviewPage(overview: RegistryOverview): HtmlEscapedString | Promise<HtmlEscapedString> {
  const sweep = overview.latestSweep;
  const enumeration = overview.latestEnumeration;
  // Staleness is measured against the last sweep that enumerated anything. A
  // failing sweep writes a receipt with a fresh timestamp, so trusting the
  // newest receipt would hide this banner for the whole of an outage.
  const staleSweep = enumeration === null
    || overview.generatedAt - enumeration.finishedAt > 3 * 60 * 60 * 1_000;
  const sweepFailing = sweep !== null && sweep.status === "failed";
  return html`
    ${sweepFailing
      ? html`<div class="banner banner-bad">The last inventory sweep failed, so nothing below
          has been reconciled against the account since
          ${enumeration === null ? "ever" : timestamp(enumeration.finishedAt)}.
          ${sweep.errorMessage ? html`<span class="mono">${sweep.errorMessage}</span>` : ""}</div>`
      : ""}
    ${staleSweep && !sweepFailing
      ? html`<div class="banner">The inventory sweep has not completed recently, so the object
          list below may be missing objects that never reported. ${enumeration === null
            ? "No sweep has enumerated the account yet."
            : html`Last enumeration finished ${timestamp(enumeration.finishedAt)}.`}</div>`
      : ""}

    <section>
      <h2>Fleet</h2>
      <div class="tiles">
        ${STATUS_ORDER.map((status) => html`
          <a class="tile" href="/objects?status=${status}">
            <div class="n">${overview.totals[status]}</div>
            <div class="k">${STATUS_LABEL[status]}</div>
          </a>`)}
        <div class="tile">
          <div class="n">${overview.totals.all}</div>
          <div class="k">Tracked objects</div>
        </div>
      </div>
    </section>

    <section>
      <h2>Components</h2>
      <div class="panel scroll">
        ${overview.components.length === 0
          ? html`<p class="empty">No component has reported a migration yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Component</th><th>Class</th><th>Region</th><th>Head</th>
                  <th>Worker version</th><th>Current</th><th>Behind</th><th>Failed</th>
                  <th>Unreported</th><th>Empty</th><th>Absent</th><th>Seen</th>
                </tr>
              </thead>
              <tbody>
                ${overview.components.map((component) => html`
                  <tr class="${component.retired ? "retired" : ""}">
                    <td>
                      <a href="/objects?component=${component.component}"><code>${component.component}</code></a>
                      ${component.retired ? html` <span class="pill retired">retired</span>` : ""}
                    </td>
                    <td>${component.className}</td>
                    <td>${component.region}</td>
                    <td class="mono">v${component.latestVersion}</td>
                    <td class="mono muted">${component.workerVersionId}</td>
                    <td>${component.current}</td>
                    <td>${component.behind > 0 ? html`<span class="pill behind">${component.behind}</span>` : "0"}</td>
                    <td>${component.failed > 0 ? html`<span class="pill failed">${component.failed}</span>` : "0"}</td>
                    <td class="muted">${component.unreported}</td>
                    <td class="muted">${component.empty}</td>
                    <td class="muted">${component.absent}</td>
                    <td class="muted">${timestamp(component.observedAt)}</td>
                  </tr>`)}
              </tbody>
            </table>`}
      </div>
    </section>

    <section>
      <h2>Open failures</h2>
      <div class="panel scroll">
        ${overview.recentFailures.length === 0
          ? html`<p class="empty">No object is currently reporting a failed migration.</p>`
          : objectTable(overview.recentFailures)}
      </div>
    </section>

    <section>
      <h2>Recent reports</h2>
      <div class="panel scroll">
        ${overview.recentEvents.length === 0
          ? html`<p class="empty">No migration report has arrived yet.</p>`
          : eventTable(overview.recentEvents, true)}
      </div>
    </section>

    <section>
      <h2>Namespaces</h2>
      <div class="panel scroll">
        ${overview.namespaces.length === 0
          ? html`<p class="empty">No inventory sweep has enumerated the account yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Script</th><th>Class</th><th>Storage</th><th>Stored</th><th>IDs</th><th>Swept</th>
                </tr>
              </thead>
              <tbody>
                ${overview.namespaces.map((namespace) => html`
                  <tr class="${namespace.retiredAt === null ? "" : "retired"}">
                    <td>
                      <a href="/objects?script=${namespace.scriptName}">${namespace.scriptName}</a>
                      ${namespace.retiredAt === null
                        ? ""
                        : html` <span class="pill retired">retired</span>`}
                    </td>
                    <td>${namespace.className}</td>
                    <td class="muted">${namespace.usesSqlite ? "SQLite" : "key-value"}</td>
                    <td>${namespace.storedObjectCount}</td>
                    <td>${namespace.objectCount}</td>
                    <td class="muted">${namespace.retiredAt === null
                      ? timestamp(namespace.lastSweptAt)
                      : html`gone since ${timestamp(namespace.retiredAt)}`}</td>
                  </tr>`)}
              </tbody>
            </table>`}
      </div>
      <p class="pager">
        Registry schema v${overview.registrySchemaVersion}.
        ${sweep === null
          ? "No sweep recorded."
          : html`Last sweep ${sweep.status}, ${sweep.namespaceCount} namespaces,
              ${sweep.objectCount} object IDs, finished ${timestamp(sweep.finishedAt)}.
              ${sweep.truncatedNamespaces.length > 0
                ? html`<strong>${sweep.truncatedNamespaces.length} namespace(s) truncated.</strong>`
                : ""}
              ${sweep.errorMessage ? html`<span class="failure">${sweep.errorMessage}</span>` : ""}`}
      </p>
    </section>`;
}

export function objectsPage(
  page: TrackedObjectPage,
  query: ObjectQuery,
  options: { components: string[]; scripts: string[] },
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const shown = Math.min(page.offset + page.limit, page.total);
  return html`
    <section>
      <h2>Objects</h2>
      <form class="filters" method="get" action="/objects">
        <label>Status
          <select name="status">
            <option value="">any</option>
            ${STATUS_ORDER.map((status) => html`
              <option value="${status}" ${query.status === status ? raw("selected") : ""}>
                ${STATUS_LABEL[status]}
              </option>`)}
          </select>
        </label>
        <label>Component
          <select name="component">
            <option value="">any</option>
            ${options.components.map((component) => html`
              <option value="${component}" ${query.component === component ? raw("selected") : ""}>
                ${component}
              </option>`)}
          </select>
        </label>
        <label>Script
          <select name="script">
            <option value="">any</option>
            ${options.scripts.map((script) => html`
              <option value="${script}" ${query.scriptName === script ? raw("selected") : ""}>
                ${script}
              </option>`)}
          </select>
        </label>
        <label>Region
          <select name="region">
            <option value="">any</option>
            ${["global", "eu"].map((region) => html`
              <option value="${region}" ${query.region === region ? raw("selected") : ""}>
                ${region}
              </option>`)}
          </select>
        </label>
        <label>ID or name
          <input type="search" name="search" value="${query.search ?? ""}" placeholder="prefix" />
        </label>
        <button type="submit">Filter</button>
      </form>

      <div class="panel scroll">
        ${page.objects.length === 0
          ? html`<p class="empty">No object matches this filter.</p>`
          : objectTable(page.objects)}
      </div>

      <div class="pager">
        <span>${page.total === 0 ? 0 : page.offset + 1}–${shown} of ${page.total}</span>
        ${page.offset > 0
          ? html`<a href="${pageLink(query, Math.max(0, page.offset - page.limit))}">← previous</a>`
          : ""}
        ${page.offset + page.limit < page.total
          ? html`<a href="${pageLink(query, page.offset + page.limit)}">next →</a>`
          : ""}
      </div>
    </section>`;
}

export function objectPage(detail: ObjectDetail): HtmlEscapedString | Promise<HtmlEscapedString> {
  const object = detail.object;
  return html`
    <section>
      <h2>Object</h2>
      <div class="panel">
        <dl class="facts">
          <dt>Status</dt><dd>${statusPill(object.status)}</dd>
          <dt>Object ID</dt><dd class="mono">${object.objectId}</dd>
          <dt>Name</dt><dd class="mono">${object.objectName ?? "—"}</dd>
          <dt>Class</dt><dd>${object.className ?? "—"}</dd>
          <dt>Component</dt><dd><code>${object.component ?? "—"}</code></dd>
          <dt>Script</dt><dd>${object.scriptName ?? "—"}</dd>
          <dt>Region</dt><dd>${object.region ?? "—"}${object.appEnv ? html` · ${object.appEnv}` : ""}</dd>
          <dt>Schema version</dt>
          <dd class="mono">
            ${object.schemaVersion === null ? "unknown" : html`v${object.schemaVersion}`}
            ${object.componentLatestVersion === null
              ? ""
              : html` <span class="muted">of v${object.componentLatestVersion}</span>`}
          </dd>
          <dt>Worker version</dt><dd class="mono">${object.workerVersionId ?? "—"}</dd>
          <dt>Stored data</dt><dd>${object.hasStoredData ? "yes" : "no"}</dd>
          <dt>First seen</dt><dd class="muted">${timestamp(object.firstSeenAt)}</dd>
          <dt>Last swept</dt><dd class="muted">${timestamp(object.lastSweptAt)}</dd>
          <dt>Last reported</dt><dd class="muted">${timestamp(object.lastReportedAt)}</dd>
          ${object.failureMessage
            ? html`<dt>Failure</dt>
                <dd class="failure mono">${object.failureMessage}
                  ${object.failureVersion === null ? "" : html` (v${object.failureVersion})`}</dd>`
            : ""}
          ${object.namespaceRetiredAt === null
            ? ""
            : html`<dt>Class retired</dt>
                <dd class="muted">${timestamp(object.namespaceRetiredAt)} —
                  this class no longer has a namespace in the account</dd>`}
          ${object.absentSince === null
            ? ""
            : html`<dt>Absent since</dt><dd class="muted">${timestamp(object.absentSince)}</dd>`}
        </dl>
      </div>
    </section>

    <section>
      <h2>Report history</h2>
      <div class="panel scroll">
        ${detail.events.length === 0
          ? object.status === "empty"
            ? html`<p class="empty">Cloudflare still enumerates this object ID, but the latest
                inventory sweep found no stored data. It is retained as history and is not a
                forced-migration target.</p>`
            : html`<p class="empty">This object has never reported. The inventory sweep found it,
                and it has not woken since.</p>`
          : eventTable(detail.events, false)}
      </div>
    </section>`;
}

/**
 * The one page on this site that writes something.
 *
 * It is deliberately plain and deliberately explicit about size. Forcing a
 * class wakes every live object in it, so the number of objects a choice would
 * reach is rendered next to the choice rather than discovered afterwards, and
 * the reasons somebody would force a class — objects behind, failed, or never
 * heard from — are on the same row.
 */
export function migrationsPage(
  overview: MigrationsOverview,
  highlightRunId: string | null,
  problem?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const classes = [...new Set(overview.components.map((component) => component.className))].sort();
  const unreachable = (["global", "eu"] as const)
    .filter((region) => !overview.dispatchableRegions.includes(region));
  return html`
    ${problem ? html`<div class="banner banner-bad">${problem}</div>` : ""}
    ${unreachable.length === 0
      ? ""
      : html`<div class="banner">This deployment holds no command queue for
          ${unreachable.join(" or ")}, so objects in
          ${unreachable.length === 1 ? "that region" : "those regions"} cannot be
          reached. They are counted as unroutable rather than sent.</div>`}

    <section>
      <h2>Force a migration</h2>
      <div class="panel">
        <div class="run-panel">
        <form class="filters" method="post" action="/migrations">
          <label>Class
            <select name="className" required>
              ${classes.length === 0
                ? html`<option value="">no class has been enumerated yet</option>`
                : classes.map((className) => html`<option value="${className}">${className}</option>`)}
            </select>
          </label>
          <label>Region
            <select name="region">
              <option value="">both</option>
              ${overview.dispatchableRegions.map((region) => html`
                <option value="${region}">${region}</option>`)}
            </select>
          </label>
          <button type="submit" ${classes.length === 0 ? raw("disabled") : ""}>
            Migrate every object
          </button>
        </form>
        <p class="note">Every live object of the class is sent one message, and each
          message wakes that object so it applies whatever its schema ledger is
          missing. Empty and absent identities are not woken. Nothing here is
          instant: the objects report back as they wake, and the
          <a href="/">overview</a> is where that arrives.</p>
        </div>
      </div>
    </section>

    <section>
      <h2>What a run would reach</h2>
      <div class="panel scroll">
        ${overview.components.length === 0
          ? html`<p class="empty">No inventory sweep has enumerated a migrating class yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Class</th><th>Region</th><th>Objects</th><th>Behind</th>
                  <th>Failed</th><th>Unreported</th>
                </tr>
              </thead>
              <tbody>
                ${overview.components.map((component) => html`
                  <tr>
                    <td>${component.className}</td>
                    <td class="muted">${component.region}</td>
                    <td>${component.objects}</td>
                    <td>${component.behind > 0
                      ? html`<span class="pill behind">${component.behind}</span>`
                      : "0"}</td>
                    <td>${component.failed > 0
                      ? html`<span class="pill failed">${component.failed}</span>`
                      : "0"}</td>
                    <td class="muted">${component.unreported}</td>
                  </tr>`)}
              </tbody>
            </table>`}
      </div>
    </section>

    <section>
      <h2>Recent runs</h2>
      <div class="panel scroll">
        ${overview.runs.length === 0
          ? html`<p class="empty">No migration has been forced from this site.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Started</th><th>Class</th><th>Region</th><th>Dispatched</th>
                  <th>Unroutable</th><th>Status</th><th>By</th><th>Detail</th>
                </tr>
              </thead>
              <tbody>
                ${overview.runs.map((run) => html`
                  <tr class="${run.runId === highlightRunId ? "highlight" : ""}">
                    <td class="muted">${timestamp(run.requestedAt)}</td>
                    <td>${run.className}</td>
                    <td class="muted">${run.region ?? "both"}</td>
                    <td class="mono">${run.dispatched} of ${run.matched}</td>
                    <td class="muted">${run.unroutable}</td>
                    <td><span class="pill ${run.status === "failed" ? "failed" : "current"}">
                      ${run.status}</span></td>
                    <td class="muted">${run.requestedBy}</td>
                    <td class="failure">
                      ${run.truncated
                        ? html`<strong>capped — the class holds more objects than one run
                            sends; run it again to continue.</strong> `
                        : ""}
                      ${run.errorMessage ?? ""}</td>
                  </tr>`)}
              </tbody>
            </table>`}
      </div>
    </section>`;
}

export function notFoundPage(): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`
    <section>
      <div class="panel"><p class="empty">No such object is tracked.</p></div>
    </section>`;
}

function objectTable(objects: TrackedObject[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<table>
    <thead>
      <tr>
        <th>Status</th><th>Object</th><th>Component</th><th>Region</th>
        <th>Version</th><th>Last report</th><th>Detail</th>
      </tr>
    </thead>
    <tbody>
      ${objects.map((object) => html`
        <tr>
          <td>${statusPill(object.status)}</td>
          <td title="${object.objectName ?? object.objectId}">
            <a class="mono" href="/objects/${object.objectId}">
              ${object.objectName === null ? shortId(object.objectId) : shortName(object.objectName)}
            </a>
          </td>
          <td><code>${object.component ?? object.className ?? "—"}</code></td>
          <td class="muted">${object.region ?? "—"}</td>
          <td class="mono">
            ${object.schemaVersion === null ? "—" : html`v${object.schemaVersion}`}
            ${object.componentLatestVersion === null
              ? ""
              : html`<span class="muted"> / v${object.componentLatestVersion}</span>`}
          </td>
          <td class="muted">${timestamp(object.lastReportedAt)}</td>
          <td class="failure">${object.failureMessage ?? ""}</td>
        </tr>`)}
    </tbody>
  </table>`;
}

function eventTable(
  events: MigrationEvent[],
  withObject: boolean,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<table>
    <thead>
      <tr>
        <th>When</th>${withObject ? html`<th>Object</th>` : ""}<th>Status</th>
        <th>Version</th><th>Head</th><th>Worker version</th><th>Detail</th>
      </tr>
    </thead>
    <tbody>
      ${events.map((event) => html`
        <tr>
          <td class="muted">${timestamp(event.occurredAt)}</td>
          ${withObject
            ? html`<td title="${event.objectName ?? event.objectId}">
                <a class="mono" href="/objects/${event.objectId}">
                  ${event.objectName === null
                    ? shortId(event.objectId)
                    : shortName(event.objectName)}</a></td>`
            : ""}
          <td><span class="pill ${event.status === "failed" ? "failed" : "current"}">${event.status}</span></td>
          <td class="mono">v${event.schemaVersion}</td>
          <td class="mono muted">v${event.latestVersion}</td>
          <td class="mono muted">${event.workerVersionId}</td>
          <td class="failure">${event.failureMessage ?? ""}</td>
        </tr>`)}
    </tbody>
  </table>`;
}

function statusPill(status: ObjectStatus): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<span class="pill ${status}">${STATUS_LABEL[status]}</span>`;
}

function shortId(objectId: string): string {
  return `${objectId.slice(0, 12)}…`;
}

/**
 * A full object name is four UUIDs and runs past 70 characters, which in a table
 * of them pushes every later column — including the timestamp an operator is
 * scanning for — out of view. Each segment is abbreviated to the first eight
 * characters, which is more than enough to tell two objects apart at a glance;
 * the row's `title` and the object page both carry the whole thing.
 */
function shortName(name: string): string {
  return name
    .split(":")
    .map((segment) => (segment.length > 12 ? `${segment.slice(0, 8)}…` : segment))
    .join(":");
}

function timestamp(value: number | null): string {
  if (value === null) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function pageLink(query: ObjectQuery, offset: number): string {
  const parameters = new URLSearchParams();
  if (query.status) parameters.set("status", query.status);
  if (query.component) parameters.set("component", query.component);
  if (query.region) parameters.set("region", query.region);
  if (query.scriptName) parameters.set("script", query.scriptName);
  if (query.search) parameters.set("search", query.search);
  parameters.set("limit", String(query.limit));
  if (offset > 0) parameters.set("offset", String(offset));
  return `/objects?${parameters.toString()}`;
}
