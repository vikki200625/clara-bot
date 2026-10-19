// Trigger-math tests (node --test, no deps). Pure decision functions only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inWin, ist, ladderDecision, windowDecision } from "../lib/proactive.mjs";
import { cleanReply } from "../lib/brain.mjs";

test("inWin: inclusive bounds", () => {
  const w = [8, 30, 10, 30]; // 08:30–10:30
  assert.equal(inWin(w, 8, 29), false);
  assert.equal(inWin(w, 8, 30), true);
  assert.equal(inWin(w, 9, 0), true);
  assert.equal(inWin(w, 10, 30), true);
  assert.equal(inWin(w, 10, 31), false);
});

test("ist: UTC+5:30 date + hour", () => {
  // 2026-10-20 03:30 UTC = 09:00 IST same day
  const p = ist(Date.UTC(2026, 9, 20, 3, 30));
  assert.equal(p.h, 9);
  assert.equal(p.m, 0);
  assert.equal(p.day, "2026-10-20");
  // 2026-10-20 19:00 UTC = 00:30 IST NEXT day
  const p2 = ist(Date.UTC(2026, 9, 20, 19, 0));
  assert.equal(p2.h, 0);
  assert.equal(p2.day, "2026-10-21");
});

test("cleanReply: strips labels and wrapping quotes", () => {
  assert.equal(cleanReply("clara: hey"), "hey");
  assert.equal(cleanReply("**Clara:** hey"), "hey");
  assert.equal(cleanReply("SARA — hey"), "hey");
  assert.equal(cleanReply("“hey”"), "hey");
  assert.equal(cleanReply("hey"), "hey");
  assert.equal(cleanReply("clara: clara: hey"), "hey"); // double strip loop
});

// ── proactive v2 decisions ────────────────────────────────────────────
const H = 3600_000;
// Fixed IST clocks: 08:00 = 02:30Z, 09:00 = 03:30Z, 12:30 = 07:00Z, 23:15 = 17:15Z
const EIGHT_AM = Date.UTC(2026, 9, 20, 2, 30);
const MORNING = Date.UTC(2026, 9, 20, 3, 30);
const NOON = Date.UTC(2026, 9, 20, 7, 0);
const NIGHT = Date.UTC(2026, 9, 20, 17, 15);

test("gm: fires in window with fresh state and old-enough conversation", () => {
  const msgs = [
    { role: "user", content: "hi", t: NOON - 4 * H },
    { role: "assistant", content: "hey", t: NOON - 4 * H + 60000 },
  ];
  const d = windowDecision("morning", {
    msgs, state: { morning: { day: "2026-10-19" } }, now: MORNING,
  });
  assert.equal(d.fire, true);
});

test("gm: its own day stamp blocks a second send", () => {
  const msgs = [{ role: "user", content: "hi", t: MORNING - 20 * H }];
  const d = windowDecision("morning", {
    msgs, state: { morning: { day: "2026-10-20" } }, now: MORNING,
  });
  assert.equal(d.reason, "already-sent-today");
});

test("gn: its own day stamp — a ladder/morning stamp can't poison it", () => {
  const msgs = [{ role: "user", content: "hi", t: NIGHT - 5 * H }];
  const state = {
    morning: { day: "2026-10-20" },
    ladder: { stage: 1, lastNudgeAt: NIGHT - 6 * H },
  };
  const d = windowDecision("night", { msgs, state, now: NIGHT });
  assert.equal(d.fire, true);
});

test("gm: dormant past 48h of silence", () => {
  const msgs = [{ role: "user", content: "hi", t: MORNING - 50 * H }];
  const d = windowDecision("morning", { msgs, state: {}, now: MORNING });
  assert.equal(d.reason, "dormant");
});

test("ladder: read 3h ago → rung 1 (sass)", () => {
  const lastA = NOON - 4 * H;
  const msgs = [
    { role: "user", content: "hi", t: lastA - 60000 },
    { role: "assistant", content: "hey", t: lastA },
  ];
  const d = ladderDecision({ msgs, seen: { read_at: NOON - 3 * H }, state: {}, now: NOON });
  assert.deepEqual({ fire: d.fire, rung: d.rung }, { fire: true, rung: 1 });
});

test("ladder: read but 3h not up → waiting", () => {
  const msgs = [{ role: "assistant", content: "hey", t: NOON - 2 * H }];
  const d = ladderDecision({ msgs, seen: { read_at: NOON - 1 * H }, state: {}, now: NOON });
  assert.equal(d.reason, "waiting");
});

test("ladder: read of an OLD message doesn't count", () => {
  const lastA = NOON - 1 * H; // she texted AFTER his last read
  const msgs = [{ role: "assistant", content: "hey", t: lastA }];
  const d = ladderDecision({ msgs, seen: { read_at: NOON - 4 * H }, state: {}, now: NOON });
  assert.equal(d.reason, "waiting"); // unseen path: 5h not up
});

test("ladder: no read signal → rung 1 after 5h anyway (never gated)", () => {
  const msgs = [{ role: "assistant", content: "hey", t: NOON - 6 * H }];
  const d = ladderDecision({ msgs, seen: null, state: {}, now: NOON });
  assert.deepEqual({ fire: d.fire, rung: d.rung }, { fire: true, rung: 1 });
});

test("ladder: rung 2 waits 4h after rung 1", () => {
  const msgs = [{ role: "assistant", content: "nudge", t: NOON - 10 * H }];
  const waiting = ladderDecision({
    msgs, seen: null, state: { ladder: { stage: 1, lastNudgeAt: NOON - 3 * H } }, now: NOON,
  });
  assert.equal(waiting.reason, "waiting");
  const fire = ladderDecision({
    msgs, seen: null, state: { ladder: { stage: 1, lastNudgeAt: NOON - 5 * H } }, now: NOON,
  });
  assert.deepEqual({ fire: fire.fire, rung: fire.rung }, { fire: true, rung: 2 });
});

test("ladder: exhausted after rung 2 — she goes quiet", () => {
  const msgs = [{ role: "assistant", content: "worry", t: NOON - 10 * H }];
  const d = ladderDecision({ msgs, seen: null, state: { ladder: { stage: 2 } }, now: NOON });
  assert.equal(d.reason, "ladder-exhausted");
});

test("ladder: his reply kills it", () => {
  const msgs = [
    { role: "assistant", content: "hey", t: NOON - 6 * H },
    { role: "user", content: "sorry was busy", t: NOON - 1 * H },
  ];
  const d = ladderDecision({ msgs, seen: null, state: {}, now: NOON });
  assert.equal(d.reason, "conversation-live");
});

test("ladder: pre-morning hours are off-limits (morning owns the dawn)", () => {
  const msgs = [{ role: "assistant", content: "hey", t: EIGHT_AM - 6 * H }];
  const d = ladderDecision({ msgs, seen: null, state: {}, now: EIGHT_AM });
  assert.equal(d.reason, "outside-ladder-hours");
});
