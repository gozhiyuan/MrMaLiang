export type EmbeddingClient = {
  model: string;
  embed(inputs: string[]): Promise<number[][]>;
};

export type EmbeddingSettings = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function baseUrl(settings: EmbeddingSettings): string {
  return (settings.baseUrl ?? process.env.MALACLAW_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

function apiKey(settings: EmbeddingSettings): string | undefined {
  return settings.apiKey ?? process.env.MALACLAW_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
}

/** OpenAI-compatible embeddings are optional. Credentials stay in the
 * environment; longwrite.yaml records only the backend/model contract. */
export function openAICompatibleEmbeddings(settings: EmbeddingSettings = {}): EmbeddingClient {
  const key = apiKey(settings);
  if (!key) throw new Error("hybrid_openai retrieval requires MALACLAW_OPENAI_API_KEY/OPENAI_API_KEY");
  const model = settings.model ?? process.env.MALACLAW_EMBEDDING_MODEL ?? "text-embedding-3-small";
  return {
    model,
    async embed(inputs: string[]): Promise<number[][]> {
      const response = await fetch(`${baseUrl(settings)}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: inputs }),
      });
      if (!response.ok) throw new Error(`embedding API failed: HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = payload.data ?? [];
      const output = rows
        .filter((row): row is { index: number; embedding: number[] } => Number.isInteger(row.index) && Array.isArray(row.embedding))
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);
      if (output.length !== inputs.length || output.some((vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error("embedding API returned an invalid vector batch");
      }
      return output;
    },
  };
}

