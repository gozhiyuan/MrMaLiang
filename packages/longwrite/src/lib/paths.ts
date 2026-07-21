import path from "node:path";
import { fileURLToPath } from "node:url";

/** dist/lib/paths.js -> package root. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function modesDir(): string {
  return process.env.LONGWRITE_MODES_DIR ?? path.join(packageRoot(), "configs", "modes");
}

export function runtimeProfilesDir(): string {
  return process.env.LONGWRITE_RUNTIME_PROFILES_DIR ?? path.join(packageRoot(), "configs", "runtime-profiles");
}

export function templatesDir(): string {
  return process.env.LONGWRITE_TEMPLATES_DIR ?? path.join(packageRoot(), "templates");
}
