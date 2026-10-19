// Trigger-math tests (node --test, no deps). Pure helpers only — these
// pin down the stable primitives; decision tests land with proactive v2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inWin, ist } from "../lib/proactive.mjs";
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
