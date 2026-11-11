// Getting Started with Canvases: the guide's server and its stored data.
//
// README.md beside this file says what the site is for, what each table
// holds, and the statements Rally sends from the Chat. Read it before
// changing anything here.

import { DurableObject } from "cloudflare:workers";

/** Every step of the guide, in the order the page shows them. */
const STEPS = ["use_the_page", "ask_rally", "comment", "make_it_yours", "teammate", "own_canvas"];

/** Steps done once for the whole team: whoever does one ticks it for everybody. */
const TEAM_STEPS = new Set(["make_it_yours", "teammate"]);

/**
 * The wall's title in `index.html`. Renaming it is step 3, so it is left out
 * when the page is compared with the one this site started as.
 */
const WALL_TITLE = /<h2 id="wall-title"[^>]*>[\s\S]*?<\/h2>/u;

const STARTER_CARDS = [
  "A tracker for our hiring plan",
  "A launch checklist with owners and dates",
  "A weekly status page for the team",
];

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    // Every statement here runs on every start, so each is safe to repeat.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS wall_cards (
         id INTEGER PRIMARY KEY,
         text TEXT NOT NULL,
         -- The page names the kind on every card it writes. A row written
         -- from the Chat with only its text is therefore Rally's.
         added_by_kind TEXT NOT NULL DEFAULT 'rally' CHECK (added_by_kind IN ('person', 'rally', 'starter')),
         added_by_id TEXT,
         added_by_name TEXT NOT NULL DEFAULT 'Rally',
         asked_by_id TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS wall_votes (
         card_id INTEGER NOT NULL,
         voter_id TEXT NOT NULL,
         voter_name TEXT NOT NULL,
         voted_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (card_id, voter_id)
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS guide_steps_done (
         person_id TEXT NOT NULL,
         person_name TEXT NOT NULL,
         step TEXT NOT NULL,
         done_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (person_id, step)
       )`,
    );
    // The wall starts with a few cards so nobody meets an empty page. The flag
    // keeps them from coming back after someone clears them.
    if (!this.ctx.storage.kv.get("starter_cards_added")) {
      for (const text of STARTER_CARDS) {
        sql.exec(
          "INSERT INTO wall_cards (text, added_by_kind, added_by_name) VALUES (?, 'starter', 'Rally')",
          text,
        );
      }
      this.ctx.storage.kv.put("starter_cards_added", true);
    }
  }

  async fetch(request) {
    // The wall shows people's names, so the whole site is for signed-in
    // viewers: the page, its assets and its routes alike.
    const viewerId = request.headers.get("x-rally-viewer-id");
    if (!viewerId) {
      return new Response("Sign in to view this site.", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const viewer = {
      id: viewerId,
      name: decodeURIComponent(request.headers.get("x-rally-viewer-name") ?? "") || "Someone",
    };
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === "POST";

    if (path === "/api/state" && request.method === "GET") return json(await this.state(viewer));

    if (path === "/api/cards" && post) {
      const body = await readJson(request);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text === "") return json({ error: "text must not be empty" }, 400);
      this.ctx.storage.sql.exec(
        "INSERT INTO wall_cards (text, added_by_kind, added_by_id, added_by_name) VALUES (?, 'person', ?, ?)",
        text,
        viewer.id,
        viewer.name,
      );
      return json(await this.state(viewer));
    }

    const cardAction = /^\/api\/cards\/(\d+)\/(vote|remove)$/.exec(path);
    if (cardAction && post) {
      const cardId = Number(cardAction[1]);
      const card = this.ctx.storage.sql
        .exec("SELECT id, added_by_kind, added_by_id FROM wall_cards WHERE id = ?", cardId)
        .toArray()[0];
      if (!card) return json({ error: "no such card" }, 404);
      if (cardAction[2] === "vote") {
        // One vote per person per card: voting again takes the vote back.
        const removed = this.ctx.storage.sql
          .exec("DELETE FROM wall_votes WHERE card_id = ? AND voter_id = ? RETURNING card_id", cardId, viewer.id)
          .toArray();
        if (removed.length === 0) {
          this.ctx.storage.sql.exec(
            "INSERT INTO wall_votes (card_id, voter_id, voter_name) VALUES (?, ?, ?)",
            cardId,
            viewer.id,
            viewer.name,
          );
        }
      } else {
        if (card.added_by_kind !== "person" || card.added_by_id !== viewer.id) {
          // Not 403: the page reads 401 and 403 as the viewer's session ending.
          return json({ error: "you have no such card to remove" }, 404);
        }
        this.ctx.storage.sql.exec("DELETE FROM wall_votes WHERE card_id = ?", cardId);
        this.ctx.storage.sql.exec("DELETE FROM wall_cards WHERE id = ?", cardId);
      }
      return json(await this.state(viewer));
    }

    if (path === "/api/steps" && post) {
      const body = await readJson(request);
      if (!STEPS.includes(body?.step)) return json({ error: `step must be one of ${STEPS.join(", ")}` }, 400);
      this.ctx.storage.sql.exec(
        "INSERT INTO guide_steps_done (person_id, person_name, step) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        viewer.id,
        viewer.name,
        body.step,
      );
      return json(await this.state(viewer));
    }

    if (path.startsWith("/api/")) return json({ error: "no such route" }, 404);
    return this.env.ASSETS.fetch(request);
  }

  /** Everything the page draws, for one viewer. */
  async state(viewer) {
    const sql = this.ctx.storage.sql;
    const cards = sql
      .exec(
        `SELECT c.id, c.text, c.added_by_kind, c.added_by_id, c.added_by_name,
                (SELECT COUNT(*) FROM wall_votes v WHERE v.card_id = c.id) AS votes,
                EXISTS (SELECT 1 FROM wall_votes v WHERE v.card_id = c.id AND v.voter_id = ?) AS voted
           FROM wall_cards c
          ORDER BY votes DESC, c.id DESC`,
        viewer.id,
      )
      .toArray()
      .map((card) => ({
        id: card.id,
        text: card.text,
        kind: card.added_by_kind,
        by: card.added_by_name,
        votes: card.votes,
        voted: card.voted === 1,
        mine: card.added_by_kind === "person" && card.added_by_id === viewer.id,
      }));
    return { viewer: { name: viewer.name }, steps: this.steps(viewer, await this.pageWasRemade()), cards };
  }

  /**
   * Whether the page's HTML differs from the HTML this site first ran with
   * here, which only a republish changes: the proof of step 4 that needs
   * nobody to record it. Read once per start, because a republish restarts
   * the class and nothing else changes the files.
   */
  async pageWasRemade() {
    if (this.remade === undefined) {
      const html = await (await this.env.ASSETS.fetch("/index.html")).text();
      const bytes = new TextEncoder().encode(html.replace(WALL_TITLE, ""));
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const first = this.ctx.storage.kv.get("first_page_digest");
      if (first === undefined) this.ctx.storage.kv.put("first_page_digest", digest);
      this.remade = first !== undefined && first !== digest;
    }
    return this.remade;
  }

  /**
   * Which steps are done, and by whom.
   *
   * A step is read from what the site can see for itself wherever it can:
   * the stored rows, and whether the page was republished. The rows in
   * `guide_steps_done`, written by the page when a person ticks a step and by
   * Rally from the Chat, cover the rest and add who did a team step.
   */
  steps(viewer, pageWasRemade) {
    const sql = this.ctx.storage.sql;
    const one = (statement, ...params) => sql.exec(statement, ...params).toArray()[0];
    const recorded = new Map();
    for (const row of sql.exec("SELECT step, person_id, person_name FROM guide_steps_done ORDER BY done_at")) {
      const mine = row.person_id === viewer.id;
      if (TEAM_STEPS.has(row.step) ? !recorded.has(row.step) : mine) {
        recorded.set(row.step, { by: mine ? "you" : row.person_name });
      }
    }

    const addedCard = one(
      "SELECT 1 AS found FROM wall_cards WHERE added_by_kind = 'person' AND added_by_id = ? LIMIT 1",
      viewer.id,
    );
    const voted = one("SELECT 1 AS found FROM wall_votes WHERE voter_id = ? LIMIT 1", viewer.id);
    // A card Rally wrote for this person, or one it wrote without saying
    // for whom: then nobody can be told apart, and it counts for everyone.
    const rallyAddedForViewer = one(
      "SELECT 1 AS found FROM wall_cards WHERE added_by_kind = 'rally' AND (asked_by_id = ? OR asked_by_id IS NULL) LIMIT 1",
      viewer.id,
    );
    // The second person to add a card, which is what shows the Canvas is shared.
    const secondPerson = one(
      `SELECT added_by_name AS name, added_by_id AS id FROM wall_cards
        WHERE added_by_kind = 'person'
        GROUP BY added_by_id ORDER BY MIN(id) LIMIT 1 OFFSET 1`,
    );

    const proved = {
      use_the_page: addedCard && voted ? { by: "you" } : null,
      ask_rally: rallyAddedForViewer ? { by: "you" } : null,
      // Rally's row names who asked; the remade page proves it without one.
      make_it_yours: recorded.get("make_it_yours") ?? (pageWasRemade ? { by: null } : null),
      teammate: secondPerson ? { by: secondPerson.id === viewer.id ? "you" : secondPerson.name } : null,
    };

    return STEPS.map((id) => {
      const done = proved[id] ?? recorded.get(id) ?? null;
      const step = { id, team: TEAM_STEPS.has(id), done: done !== null, by: done?.by ?? null };
      // The first step has two halves, and the page ticks each as it happens.
      if (id === "use_the_page") step.parts = { addedCard: Boolean(addedCard), voted: Boolean(voted) };
      return step;
    });
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
