const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync("lib/validators.js", "utf8"), context);
const validators = context.window.Threadsmith.validators;

test("extracts a normal title field", () => {
  assert.equal(
    validators.extractTitleCandidate({ title: "NUC - 静态IP迁移" }),
    "NUC - 静态IP迁移"
  );
});

test("recovers a title from a sole malformed JSON key", () => {
  assert.equal(
    validators.extractTitleCandidate({ "NUC - 静态IP与网口迁移指南": "explanation" }),
    "NUC - 静态IP与网口迁移指南"
  );
});

test("recovers a sole-key JSON object serialized into title", () => {
  assert.equal(
    validators.extractTitleCandidate({ title: '{"NUC - 静态IP与网口迁移指南":"explanation"}' }),
    "NUC - 静态IP与网口迁移指南"
  );
});

test("recovers the observed slightly malformed Ollama key", () => {
  assert.equal(
    validators.extractTitleCandidate({ title: '{"三星电视 - 背板按键 - 3D关闭指南\'}":true}' }),
    "三星电视 - 背板按键 - 3D关闭指南"
  );
});

test("rejects every title with more than one spaced separator", () => {
  assert.equal(validators.isBadTitle("三星电视 - 背板按键 - 3D关闭指南", "zh"), true);
  assert.equal(validators.isBadTitle("三星电视 - 3D模式手动关闭", "zh"), false);
});

test("does not treat explanation values as title candidates", () => {
  assert.equal(
    validators.extractTitleCandidate({ explanation: "long prose" }),
    ""
  );
});
