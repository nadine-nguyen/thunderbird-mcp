"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// updateEvent overwrote descriptions with setProperty("DESCRIPTION", ...). In
// Thunderbird's calItemBase, setProperty keeps the property's existing
// parameters, so a stale ALTREP (the HTML copy of the description) survived the
// overwrite and a CalDAV server (observed with Google Calendar) kept the old
// text while updateEvent still reported success. The descriptionText setter
// clears ALTREP. This runs production applyEventChanges against a stand-in item
// that models those calItemBase semantics (modules/CalItemBase.sys.mjs).
const apiSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/mcp_server/api.js"),
  "utf8"
);

function extract(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return apiSource.slice(start, end);
}

class FakeCalItem {
  constructor() {
    this.props = new Map();
    this.params = {};
  }
  setProperty(name, value) {
    name = name.toUpperCase();
    if (value || !isNaN(parseInt(value, 10))) {
      this.props.set(name, value);
      if (!(name in this.params)) this.params[name] = {};
    } else {
      this.deleteProperty(name);
    }
  }
  deleteProperty(name) {
    name = name.toUpperCase();
    this.props.delete(name);
    delete this.params[name];
  }
  getProperty(name) {
    const key = name.toUpperCase();
    return this.props.has(key) ? this.props.get(key) : null;
  }
  setPropertyParameter(name, param, value) {
    const key = name.toUpperCase();
    if (value) this.params[key][param.toUpperCase()] = value;
    else delete this.params[key][param.toUpperCase()];
  }
  getPropertyParameter(name, param) {
    return this.params[name.toUpperCase()]?.[param.toUpperCase()] ?? null;
  }
  set descriptionText(text) {
    this.setProperty("DESCRIPTION", text ? text.replace(/\r/g, "") : null);
    if (text) this.setPropertyParameter("DESCRIPTION", "ALTREP", null);
  }
  get descriptionText() {
    return this.getProperty("DESCRIPTION");
  }
}

function loadApplyEventChanges() {
  const source = extract("function applyEventChanges(", "async function updateEvent(");
  const sandbox = { cal: {}, DATE_ONLY_RE: /^$/ };
  vm.runInNewContext(`${source}\nthis.applyEventChanges = applyEventChanges;`, sandbox);
  return (item, description) =>
    JSON.parse(JSON.stringify(sandbox.applyEventChanges(item, undefined, undefined, undefined, undefined, description)));
}

function itemWithHtmlDescription(text, html) {
  const item = new FakeCalItem();
  item.setProperty("DESCRIPTION", text);
  item.setPropertyParameter("DESCRIPTION", "ALTREP", "data:text/html," + encodeURIComponent(html));
  return item;
}

describe("applyEventChanges description", () => {
  const applyEventChanges = loadApplyEventChanges();

  it("overwrites the text and drops the stale ALTREP HTML copy", () => {
    const item = itemWithHtmlDescription("old", "<b>old</b>");
    assert.deepEqual(applyEventChanges(item, "new"), { changes: ["description"] });
    assert.equal(item.getProperty("DESCRIPTION"), "new");
    assert.equal(item.getPropertyParameter("DESCRIPTION", "ALTREP"), null);
  });

  it("clears the description (and its parameters) for an empty string", () => {
    const item = itemWithHtmlDescription("old", "<b>old</b>");
    assert.deepEqual(applyEventChanges(item, ""), { changes: ["description"] });
    assert.equal(item.getProperty("DESCRIPTION"), null);
    assert.equal(item.getPropertyParameter("DESCRIPTION", "ALTREP"), null);
  });

  it("leaves the description and its ALTREP alone when no description is given", () => {
    const item = itemWithHtmlDescription("old", "<b>old</b>");
    assert.deepEqual(applyEventChanges(item, undefined), { changes: [] });
    assert.equal(item.getProperty("DESCRIPTION"), "old");
    assert.notEqual(item.getPropertyParameter("DESCRIPTION", "ALTREP"), null);
  });
});
