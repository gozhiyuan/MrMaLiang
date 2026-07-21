import type { RawSource } from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function words(topic: string): string[] {
  const parsed = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return [...new Set(parsed)].slice(0, 8);
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateSeedSources(topic: string, count = 8): RawSource[] {
  const terms = words(topic);
  const topicLabel = titleCase(topic || "Long Form Writing Agents");
  const baseSlug = slug(topic || "long-form-writing-agents");
  const themes = [
    "Survey",
    "Architecture",
    "Evaluation",
    "Memory",
    "Human Review",
    "Retrieval",
    "Workflow",
    "Reliability",
  ];

  return themes.slice(0, count).map((theme, index) => {
    const year = 2026 - (index % 4);
    // Ids must stay [source:id]-citable: the marker regex stops at
    // whitespace, so a space here made "Human Review" sources uncitable
    // (caught by the clean-install E2E via citation_verification).
    const themeSlug = theme.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `${baseSlug}-${themeSlug}-${year}`;
    return {
      id,
      title: `${theme} for ${topicLabel}`,
      authors: [`LongWrite Seed Author ${index + 1}`],
      year,
      venue: "LongWrite Seed Corpus",
      url: `https://example.org/${id}`,
      abstract:
        `Seed source about ${topicLabel}. Covers ${theme.toLowerCase()} concerns, ` +
        `artifact workflows, citation grounding, and long-running agent coordination.`,
      source: "seed",
      topics: terms.length > 0 ? terms : ["longwrite", "writing", "agents"],
    };
  });
}
