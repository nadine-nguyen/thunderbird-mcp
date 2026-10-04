"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// createEvent's `reminders` option (whole minutes before the start, one display
// alarm each). normalizeReminders and buildReminderAlarm run from production
// api.js under node:vm (Thunderbird classes stubbed) so these tests cannot drift
// from the real code; the tool schema and dispatcher wiring are checked as
// source contracts.
const api = fs.readFileSync(
  path.resolve(__dirname, "../extension/mcp_server/api.js"),
  "utf8"
);

function extract(startMarker, endMarker) {
  const start = api.indexOf(startMarker);
  const end = api.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return api.slice(start, end);
}

function loadNormalizeReminders() {
  const source = extract("const MAX_REMINDERS =", "function buildReminderAlarm(");
  const sandbox = {};
  vm.runInNewContext(`${source}\nthis.normalizeReminders = normalizeReminders;`, sandbox);
  // Results are built in the VM realm; copy them into this realm so strict
  // deep-equality does not fail on differing Array/Object prototypes.
  return (input) => JSON.parse(JSON.stringify(sandbox.normalizeReminders(input)));
}

describe("normalizeReminders", () => {
  const normalizeReminders = loadNormalizeReminders();

  it("treats omitted or null as no reminders", () => {
    assert.deepEqual(normalizeReminders(undefined), { minutes: [] });
    assert.deepEqual(normalizeReminders(null), { minutes: [] });
    assert.deepEqual(normalizeReminders([]), { minutes: [] });
  });

  it("accepts minutes before start, including 0 (at event time)", () => {
    assert.deepEqual(normalizeReminders([0, 1440]).minutes, [1440, 0]);
  });

  it("de-duplicates and orders largest first", () => {
    assert.deepEqual(normalizeReminders([0, 4320, 1440, 1440, 0]).minutes, [4320, 1440, 0]);
  });

  it("rejects a non-array", () => {
    assert.match(normalizeReminders("1440").error, /array/);
    assert.match(normalizeReminders(1440).error, /array/);
  });

  it("rejects non-integer, negative, string and NaN entries, naming the index", () => {
    assert.match(normalizeReminders([30, 1.5]).error, /reminders\[1\]/);
    assert.match(normalizeReminders([-1]).error, /reminders\[0\]/);
    assert.match(normalizeReminders(["30"]).error, /reminders\[0\]/);
    assert.match(normalizeReminders([NaN]).error, /reminders\[0\]/);
  });

  it("caps the count and the lead time", () => {
    assert.match(normalizeReminders(Array.from({ length: 11 }, (_, i) => i)).error, /at most 10/);
    assert.match(normalizeReminders([40321]).error, /40320/);
    assert.deepEqual(normalizeReminders([40320]).minutes, [40320]);
  });
});

describe("createEvent reminders wiring (source contract)", () => {
  const createEventSource = extract("async function createEvent(", "function normalizeEventStatus(");

  it("declares the reminders tool parameter as an array of integers", () => {
    const i = api.indexOf('name: "createEvent"');
    const j = api.indexOf('name: "listEvents"', i);
    assert.match(api.slice(i, j), /reminders:\s*\{\s*type:\s*"array",\s*items:\s*\{\s*type:\s*"integer"/);
  });

  it("passes args.reminders from the dispatcher into createEvent", () => {
    assert.match(api, /return await createEvent\([^)]*args\.reminders\)/);
  });

  it("validates reminders and adds one alarm per entry", () => {
    assert.match(createEventSource, /normalizeReminders\(reminders\)/);
    assert.match(createEventSource, /event\.addAlarm\(/);
  });

});

describe("buildReminderAlarm (production code, Thunderbird classes stubbed)", () => {
  const START = 0;
  class StubAlarm {}
  const sandbox = {
    CalAlarm: StubAlarm,
    Ci: { calIAlarm: { ALARM_RELATED_START: START } },
    cal: { createDuration: () => ({ inSeconds: 0 }) },
  };
  vm.runInNewContext(
    `${extract("function buildReminderAlarm(", "function normalizeEventStatus(")}\nthis.buildReminderAlarm = buildReminderAlarm;`,
    sandbox
  );

  it("builds a DISPLAY alarm titled after the event, relative to the start", () => {
    const alarm = sandbox.buildReminderAlarm("Team standup", 1440);
    assert.ok(alarm instanceof StubAlarm);
    assert.equal(alarm.action, "DISPLAY");
    assert.equal(alarm.description, "Team standup");
    assert.equal(alarm.related, START);
  });

  it("offsets the trigger before the start by the requested minutes", () => {
    assert.equal(sandbox.buildReminderAlarm("x", 1440).offset.inSeconds, -86400);
    assert.equal(sandbox.buildReminderAlarm("x", 30).offset.inSeconds, -1800);
  });

  it("fires at the start for 0 minutes", () => {
    assert.equal(sandbox.buildReminderAlarm("x", 0).offset.inSeconds, 0);
  });
});
