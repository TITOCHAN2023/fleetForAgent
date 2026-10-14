import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./messages";
import { getLocale, setLocale, tr } from "./locale";

test("default locale is English", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.match(tr("login.hero1"), /Any computer/);
});

test("en and zh have the same keys", () => {
  const en = Object.keys(messages.en).sort();
  const zh = Object.keys(messages.zh).sort();
  assert.deepEqual(en, zh);
});

test("switching to zh changes copy", () => {
  setLocale("zh");
  assert.equal(getLocale(), "zh");
  assert.match(tr("login.hero1"), /电脑/);
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
  assert.match(tr("guide.arch"), /Windows/);
  assert.match(tr("login.try"), /fleet\.ginfo\.cc/);
  assert.match(tr("login.body"), /Self-hosting/);
  assert.match(tr("rel.s2"), /Linux uses the CLI without a browser/);
  assert.equal(tr("home.hero"), "One tool for every computer anywhere.");
  assert.equal(tr("nav.help"), "Help");
  assert.equal(tr("nav.docs"), "Docs");
  assert.equal(tr("docs.tryAction"), "Try Fleet");
  setLocale("zh");
  assert.match(tr("guide.arch"), /连出去/);
  assert.match(tr("login.try"), /fleet\.ginfo\.cc/);
  assert.match(tr("login.body"), /自托管/);
  assert.match(tr("rel.s2"), /Linux 使用命令行，不打开浏览器/);
  assert.match(tr("home.hero"), /电脑/);
  assert.equal(tr("docs.tryAction"), "立即体验");
  setLocale("en");
});
