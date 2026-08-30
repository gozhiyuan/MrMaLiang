export type PhraseOveruse = { phrase: string; count: number; sections: string[] };

export type RedundancyReport = {
  totalWords: number;
  trackedPhraseOveruse: PhraseOveruse[];
  repeatedNgramOveruse: PhraseOveruse[];
};

const DEFAULT_TRACKED_PHRASES = ["packet", "does not establish", "not specified in packet"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, phrase: string): number {
  const pattern = new RegExp(escapeRegExp(phrase), "gi");
  return (text.match(pattern) ?? []).length;
}

function ngrams(text: string, n: number): string[] {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const grams: string[] = [];
  for (let i = 0; i + n <= words.length; i += 1) grams.push(words.slice(i, i + n).join(" "));
  return grams;
}

export type RedundancyOptions = {
  trackedPhrases?: string[];
  maxTrackedOccurrences: number;
  ngramSize?: number;
  maxNgramOccurrences: number;
};

/** Deterministic prose-redundancy scorer. Tracked phrases catch known caveat
 * boilerplate (configurable per workspace); the n-gram pass catches repeated
 * sentences/fragments across sections that a fixed phrase list would miss. */
export function computeRedundancy(
  chapters: Array<{ rel: string; content: string }>,
  opts: RedundancyOptions,
): RedundancyReport {
  const trackedPhrases = opts.trackedPhrases ?? DEFAULT_TRACKED_PHRASES;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.content.split(/\s+/).filter(Boolean).length, 0);

  const trackedPhraseOveruse: PhraseOveruse[] = [];
  for (const phrase of trackedPhrases) {
    const sections: string[] = [];
    let count = 0;
    for (const chapter of chapters) {
      const found = countOccurrences(chapter.content, phrase);
      if (found > 0) {
        count += found;
        sections.push(chapter.rel);
      }
    }
    if (count > opts.maxTrackedOccurrences) trackedPhraseOveruse.push({ phrase, count, sections });
  }

  const ngramSize = opts.ngramSize ?? 5;
  const counts = new Map<string, { count: number; sections: Set<string> }>();
  for (const chapter of chapters) {
    for (const gram of ngrams(chapter.content, ngramSize)) {
      const entry = counts.get(gram) ?? { count: 0, sections: new Set<string>() };
      entry.count += 1;
      entry.sections.add(chapter.rel);
      counts.set(gram, entry);
    }
  }
  const repeatedNgramOveruse = [...counts.entries()]
    .filter(([, entry]) => entry.count > opts.maxNgramOccurrences && entry.sections.size > 1)
    .map(([phrase, entry]) => ({ phrase, count: entry.count, sections: [...entry.sections] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return { totalWords, trackedPhraseOveruse, repeatedNgramOveruse };
}
