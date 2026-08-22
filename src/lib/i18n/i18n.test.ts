import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./messages";
import { getLocale, setLocale, tr } from "./locale";

test("default locale is English", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.match(tr("login.hero1"), /Any agent/);
});

test("en and zh have the same keys", () => {
  const en = Object.keys(messages.en).sort();
  const zh = Object.keys(messages.zh).sort();
  assert.deepEqual(en, zh);
});

test("switching to zh changes copy", () => {
  setLocale("zh");
  assert.equal(getLocale(), "zh");
  assert.match(tr("login.hero1"), /agent/);
  assert.equal(tr("tab.console"), "控制台");
  setLocale("en");
  assert.equal(tr("tab.console"), "Console");
});

test("interpolation", () => {
  setLocale("en");
  assert.equal(tr("login.continue", { label: "Google" }), "Continue with Google");
});

test("guide architecture sentence is explicit", () => {
  setLocale("en");
  assert.match(tr("guide.arch"), /dial out/);
  assert.match(tr("guide.arch"), /lists and relays/);
  setLocale("zh");
  assert.match(tr("guide.arch"), /只连出/);
  setLocale("en");
});
