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

/** LongWrite-owned role profiles. These are prompt context, not MalaClaw
 * provisioner templates and are never copied as an installable catalog. */
export function roleProfilesDir(): string {
  return process.env.LONGWRITE_ROLE_PROFILES_DIR ?? path.join(packageRoot(), "role-profiles");
}
