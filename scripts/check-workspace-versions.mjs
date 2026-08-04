#!/usr/bin/env node
/**
 * Every workspace package shares one version, and any internal dependency
 * range must still match it.
 *
 * `npm ci` resolves an internal dependency from the local workspace only while
 * its range matches that workspace's version. When it stops matching, npm
 * silently falls through to the public registry and fails on a package that
 * was never published there — an install-time error with a 404 that says
 * nothing about the real cause.
 *
 * Bumping 0.3.1 through 0.3.4 never exposed this, because `^0.3.0` kept
 * matching. The first minor bump broke CI. A release is exactly when these
 * drift, so the check belongs in `release:check` rather than in a test.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(root, rel), "utf-8"));
}

const rootPkg = await readJson("package.json");
const workspaceDirs = [];
for (const pattern of rootPkg.workspaces ?? []) {
  const [base] = pattern.split("/*");
  for (const entry of await fs.readdir(path.join(root, base), { withFileTypes: true })) {
    if (entry.isDirectory()) workspaceDirs.push(path.join(base, entry.name));
  }
}

const versions = new Map();
const manifests = [];
for (const dir of workspaceDirs) {
  const rel = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = await readJson(rel);
  } catch {
    continue;
  }
  versions.set(pkg.name, pkg.version);
  manifests.push({ rel, pkg });
}

const problems = [];
for (const { rel, pkg } of manifests) {
  if (pkg.version !== rootPkg.version) {
    problems.push(`${rel}: version ${pkg.version} does not match the root version ${rootPkg.version}`);
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      const local = versions.get(name);
      if (local === undefined) continue;
      // Only the caret form is used here; a range that cannot possibly cover
      // the local version is the failure worth naming, not exotic syntax.
      const covers = range === "*" || range === local || range === `^${local}`
        || (range.startsWith("^") && range.slice(1).split(".")[0] === local.split(".")[0] && local.split(".")[0] !== "0")
        || (range.startsWith("^") && local.startsWith("0.") && range.slice(1).split(".").slice(0, 2).join(".") === local.split(".").slice(0, 2).join("."));
      if (!covers) {
        problems.push(`${rel}: ${field}.${name} is "${range}" but the workspace publishes ${local}; npm ci will look for it on the public registry and fail`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("Workspace version check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Workspace versions coherent at ${rootPkg.version} across ${manifests.length} packages.`);
