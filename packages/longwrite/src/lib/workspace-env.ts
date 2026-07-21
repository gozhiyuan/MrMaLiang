import fs from "node:fs/promises";
import path from "node:path";

const ENV_EXAMPLE = `# Copy to .env, fill only the capabilities you choose, and keep .env private.\n# Shell environment variables take precedence over these values.\n\n# Recommended for the deep multi-provider research profile\nOPENALEX_API_KEY=\nSEMANTIC_SCHOLAR_API_KEY=\n\n# Optional: authenticated GitHub repository discovery (keyless requests are rate-limited)\nGITHUB_TOKEN=\n\n# Optional: only for hybrid OpenAI embeddings or direct API-worker stages\nOPENAI_API_KEY=\n# MALACLAW_OPENAI_API_KEY=\n\n# Optional: only for the corresponding direct API runtime or approved image feature\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\n# LONGWRITE_NANOBANANA_API_KEY=\n\n# Optional local-tool overrides\n# LONGWRITE_PYTHON_BIN=\n# LONGWRITE_MMDC_BIN=\n# LONGWRITE_LATEX_ENGINE=tectonic\n`;

function dotenvValue(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * Loads a workspace-local .env without overriding an explicitly exported shell
 * variable. It intentionally supports only KEY=value syntax: no command
 * substitution, interpolation, or executable shell fragments.
 */
export async function loadWorkspaceEnv(workspaceDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(path.resolve(workspaceDir), ".env"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const loaded: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = dotenvValue(rawValue);
    loaded.push(key);
  }
  return loaded;
}

/** Creates non-secret workspace support files without ever creating a real .env. */
export async function ensureWorkspaceEnvFiles(workspaceDir: string): Promise<string[]> {
  const resolved = path.resolve(workspaceDir);
  const written: string[] = [];
  const examplePath = path.join(resolved, ".env.example");
  try {
    await fs.access(examplePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.writeFile(examplePath, ENV_EXAMPLE, "utf-8");
    written.push(".env.example");
  }

  const gitignorePath = path.join(resolved, ".gitignore");
  let gitignore = "";
  try {
    gitignore = await fs.readFile(gitignorePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!gitignore.split(/\r?\n/).some((line) => line.trim() === ".env")) {
    const prefix = gitignore && !gitignore.endsWith("\n") ? "\n" : "";
    await fs.writeFile(gitignorePath, `${gitignore}${prefix}# Local workspace secrets\n.env\n`, "utf-8");
    written.push(".gitignore");
  }
  return written;
}
