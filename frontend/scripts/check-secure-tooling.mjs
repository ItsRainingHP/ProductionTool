/** Exercise the installed lint/generator consumers, not just a replacement import. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint, Linter } from "eslint";
import { minimatch as namedMinimatch } from "minimatch";
import { main, prepareFile } from "./secure-tooling.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromProject = createRequire(import.meta.url);
const minimatch = fromProject("minimatch");
const fromNext = createRequire(fromProject.resolve("eslint-config-next"));
const fromEslint = createRequire(fromProject.resolve("eslint"));
const fromGenerator = createRequire(fromProject.resolve("openapi-typescript"));

function lint(source, pluginName, plugin, rule, options) {
  return new Linter().verify(source, [{
    languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { [pluginName]: plugin },
    rules: { [`${pluginName}/${rule}`]: ["error", ...options] },
  }], { filename: path.join(project, "tooling-fixture.js") });
}

test("every locked minimatch is the patched engine and the installation is prepared", () => {
  main(true);
  main();
  main(true);
  const lock = JSON.parse(fs.readFileSync(path.join(project, "package-lock.json"), "utf8"));
  const installed = Object.entries(lock.packages).filter(([name]) => name.endsWith("node_modules/minimatch"));
  assert.ok(installed.length > 0);
  for (const [, entry] of installed) assert.equal(entry.version, "11.0.4");
  for (const resolver of [fromNext, fromEslint, fromGenerator]) {
    const metadata = JSON.parse(fs.readFileSync(resolver.resolve("minimatch/package.json"), "utf8"));
    assert.equal(metadata.version, "11.0.4");
  }
});

test("legacy calls and current named exports share the secure matching engine", async () => {
  const esm = await import("minimatch");
  assert.equal(typeof minimatch, "function");
  assert.equal(minimatch, minimatch.minimatch);
  assert.equal(typeof esm.default, "function");
  for (const match of [minimatch, minimatch.minimatch, namedMinimatch, esm.default, esm.minimatch]) {
    assert.equal(match("src/file.ts", "**/*.{ts,tsx}"), true);
    assert.equal(match("src/file.js", "**/*.{ts,tsx}"), false);
    assert.equal(match(".hidden.js", "*.js"), false);
    assert.equal(match(".hidden.js", "*.js", { dot: true }), true);
    assert.equal(match("src/file.js", "*.js", { matchBase: true }), true);
    assert.equal(match("renderFooter", "render*"), true);
    assert.equal(match("src/file.js", "!**/*.ts"), true);
  }
  assert.equal(new minimatch.Minimatch("**/*.tsx").match("src/page.tsx"), true);
  assert.deepEqual(minimatch.match(["a.ts", "b.js"], "*.ts"), ["a.ts"]);
  assert.equal(minimatch.defaults({ dot: true })(".hidden.js", "*.js"), true);
  assert.equal(minimatch.makeRe, undefined, "do not restore the removed backtracking RegExp API");
});

test("ESLint's ESM config selection and legacy override exclusions remain enforced", async () => {
  const cjs = fromEslint.resolve("@eslint/config-array");
  const { ConfigArray } = await import(pathToFileURL(path.resolve(path.dirname(cjs), "../esm/index.js")));
  const configs = new ConfigArray([{ files: ["**/*.js"], selected: true }], {
    basePath: project, schema: { selected: { merge: "replace", validate: "boolean" } },
  });
  await configs.normalize();
  assert.equal(configs.getConfig(path.join(project, "src/file.js")).selected, true);
  assert.equal(configs.getConfig(path.join(project, "src/file.ts")), undefined);
  const legacy = fromEslint.resolve("@eslint/eslintrc");
  const { FlatCompat } = await import(pathToFileURL(path.resolve(path.dirname(legacy), "../lib/index.js")));
  const compat = new FlatCompat({ baseDirectory: project });
  const config = compat.config({ overrides: [{ files: ["**/*.js"], excludedFiles: ["ignored/**"], rules: { "no-debugger": "error" } }] });
  const linter = new Linter();
  assert.equal(linter.verify("debugger;", config, { filename: path.join(project, "src/file.js") }).length, 1);
  assert.equal(linter.verify("debugger;", config, { filename: path.join(project, "ignored/file.js") }).length, 0);
});

test("import allow lists still allow CSS and reject unassigned JavaScript", () => {
  const plugin = fromNext("eslint-plugin-import");
  assert.deepEqual(lint('import "./styles.css";', "import", plugin, "no-unassigned-import", [{ allow: ["**/*.css"] }]), []);
  const messages = lint('import "./side-effect.js";', "import", plugin, "no-unassigned-import", [{ allow: ["**/*.css"] }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "import/no-unassigned-import");
});

test("import internal-module allow and forbid policies use secure predicates", () => {
  const plugin = fromNext("eslint-plugin-import");
  assert.deepEqual(lint('import value from "allowed/private";', "import", plugin, "no-internal-modules", [{ allow: ["allowed/**"] }]), []);
  const messages = lint('import value from "library/internal/value";', "import", plugin, "no-internal-modules", [{ forbid: ["**/internal/**"] }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "import/no-internal-modules");
});

test("React render-prop exceptions do not disable nested-component violations", () => {
  const plugin = fromNext("eslint-plugin-react");
  const options = [{ propNamePattern: "render*" }];
  assert.deepEqual(lint("function Parent() { return <View renderFooter={() => <div />} />; }", "react", plugin, "no-unstable-nested-components", options), []);
  const messages = lint("function Parent() { return <View footer={() => <div />} />; }", "react", plugin, "no-unstable-nested-components", options);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "react/no-unstable-nested-components");
});

test("accessibility control-component patterns retain positive and negative checks", () => {
  const plugin = fromNext("eslint-plugin-jsx-a11y");
  const options = [{ assert: "nesting", controlComponents: ["Control*"] }];
  assert.deepEqual(lint("const field = <label>Name<ControlInput /></label>;", "a11y", plugin, "label-has-associated-control", options), []);
  const messages = lint("const field = <label>Name<OtherInput /></label>;", "a11y", plugin, "label-has-associated-control", options);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "a11y/label-has-associated-control");
});

test("the actual Next.js config still checks source, hooks and accessibility", async () => {
  const eslint = new ESLint({ cwd: project });
  assert.equal(await eslint.isPathIgnored(path.join(project, "lib/api.ts")), false);
  assert.equal(await eslint.isPathIgnored(path.join(project, ".next/types/validator.ts")), true);
  const [result] = await eslint.lintText(
    '"use client"; import {useState} from "react"; export default function Control({enabled}) { if(enabled) useState(0); return <img src="/test.png" />; }',
    { filePath: path.join(project, "app/__tooling_control.tsx") },
  );
  assert.ok(result.messages.some((message) => message.ruleId === "react-hooks/rules-of-hooks" && message.severity === 2));
  assert.ok(result.messages.some((message) => message.ruleId === "jsx-a11y/alt-text" && message.severity === 1));
});

test("OpenAPI header glob matching and API type generation still work", async () => {
  const utils = fromGenerator(path.join(path.dirname(fromGenerator.resolve("@redocly/openapi-core")), "utils.js"));
  let headers;
  const response = await utils.readFileFromUrl("https://example.test/schema.json", {
    headers: [{ name: "X-Check", value: "matched", matches: "example.test/**" }],
    customFetch: async (_url, options) => {
      headers = options.headers;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(headers["X-Check"], "matched");
  assert.equal(response.body, "{}");
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const ast = await openapiTS({ openapi: "3.1.0", info: { title: "Tooling check", version: "1" }, paths: {},
    components: { schemas: { Column: { type: "object", properties: { replace_true_with_header: { type: "boolean" } } } } } });
  assert.match(astToString(ast), /replace_true_with_header\??: boolean/);
});

test("unknown source changes fail closed and do not get overwritten", (t) => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "production-tool-tooling-"));
  t.after(() => {
    assert.ok(path.basename(temporary).startsWith("production-tool-tooling-"));
    assert.equal(path.dirname(temporary), temporaryRoot);
    fs.rmSync(temporary, { recursive: true });
  });
  const filename = path.join(temporary, "index.js");
  const original = fs.readFileSync(fromProject.resolve("minimatch"), "utf8");
  const tampered = original.replace('"use strict"', '"changed source"');
  fs.writeFileSync(filename, tampered);
  assert.throws(() => prepareFile(filename,
    "235c5458355f1449cc100f1cea1a43d45f788a4feb524a83497aa146bea88f32", (source) => source), /Unsupported tooling source/);
  assert.equal(fs.readFileSync(filename, "utf8"), tampered);
});

test("amplifying glob input completes in a bounded child process", () => {
  const output = execFileSync(process.execPath, ["--max-old-space-size=128", "-e",
    "const {minimatch}=require('minimatch'); const value=minimatch('a/file.txt','a/**/../'.repeat(16)+'*.txt',{optimizationLevel:2}); console.log(typeof value);"],
  { cwd: project, timeout: 5000, encoding: "utf8" });
  assert.equal(output.trim(), "boolean");
});
