/**
 * Keep the audited minimatch engine while adapting the pinned tools' older API.
 * No matching algorithm or security check is changed. See README.md.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromProject = createRequire(path.join(project, "package.json"));
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function prepareFile(filename, expectedHash, transform) {
  const current = fs.readFileSync(filename, "utf8");
  const original = current.split("\n// Production Tool minimatch API adapter\n")[0];
  if (digest(original) !== expectedHash) {
    throw new Error(`Unsupported tooling source: ${path.basename(filename)}. Review the adapter before updating dependencies.`);
  }
  const patched = transform(original);
  if (current !== original && current !== patched) {
    throw new Error(`Unexpected tooling modification: ${path.basename(filename)}`);
  }
  return { filename, current, patched };
}

function packageRoot(manifest, name, expectedVersion) {
  const root = path.dirname(manifest);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (metadata.version !== expectedVersion) {
    throw new Error(`Unsupported ${name} ${metadata.version}; expected ${expectedVersion}`);
  }
  const relative = path.relative(fs.realpathSync(path.join(project, "node_modules")), fs.realpathSync(root));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Tooling adapter must only modify this project's installed dependencies");
  }
  return root;
}

function prepare() {
  const minimatch = packageRoot(fromProject.resolve("minimatch/package.json"), "minimatch", "11.0.4");
  const fromNext = createRequire(fromProject.resolve("eslint-config-next"));
  const importer = packageRoot(fromNext.resolve("eslint-plugin-import/package.json"), "eslint-plugin-import", "2.32.0");
  const marker = "\n// Production Tool minimatch API adapter\n";
  const plans = [
    prepareFile(path.join(minimatch, "dist/commonjs/index.js"),
      "235c5458355f1449cc100f1cea1a43d45f788a4feb524a83497aa146bea88f32",
      (source) => source + marker + "module.exports = Object.assign(exports.minimatch, exports);\n"),
    prepareFile(path.join(minimatch, "dist/esm/index.js"),
      "b238ca70371b1f192817ae9516afaacb566d1df2a7a85e47c6c24f41f1707864",
      (source) => source + marker + "export default minimatch;\n"),
  ];
  const rule = path.join(importer, "lib/rules/no-internal-modules.js");
  const originalHash = "f36ab9b9b97cc2d8a49f8fe474c4200875db4fa357c5061fe71538b01db696a4";
  const originalCall = "return _minimatch2['default'].makeRe(p);";
  const modernCall = "return { test: function (value) { return _minimatch2['default'](value, p); } };";
  // Keep the original rule intact for integrity/idempotence checks, then replace
  // its deprecated RegExp factory with the secure engine's predicate. The rule
  // only calls .test(); it does not need or receive a backtracking RegExp.
  const installed = fs.readFileSync(rule, "utf8");
  const original = installed.replaceAll(modernCall, originalCall);
  if (digest(original) !== originalHash || original.split(originalCall).length !== 3) {
    throw new Error("Unsupported eslint-plugin-import rule source; review the minimatch migration");
  }
  plans.push({ filename: rule, current: installed, patched: original.replaceAll(originalCall, modernCall) });
  return plans;
}

export function main(checkOnly = false) {
  let plans;
  try {
    plans = prepare();
  } catch (error) {
    const productionOnly = process.env.NODE_ENV === "production"
      || /(?:^|\s)dev(?:\s|$)/.test(process.env.npm_config_omit || "");
    if (productionOnly && error.code === "MODULE_NOT_FOUND"
      && !fs.existsSync(path.join(project, "node_modules/minimatch"))) {
      console.log("Development tooling omitted; no minimatch adapter needed.");
      return;
    }
    throw error;
  }
  // Validate every source before changing any file. Unknown updates fail closed.
  if (checkOnly) {
    if (plans.some((plan) => plan.current !== plan.patched)) {
      throw new Error("Secure tooling adapter is missing. Run npm ci with install scripts enabled.");
    }
  } else {
    for (const plan of plans) {
      if (plan.current !== plan.patched) fs.writeFileSync(plan.filename, plan.patched);
    }
  }
  console.log("Secure tooling verified: minimatch 11.0.4; legacy API consumers adapted.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.includes("--check"));
}
