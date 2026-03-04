export interface QmdSnippet {
  text: string;
  score?: number;
}

const pickSnippetText = (value: Record<string, unknown>) => {
  const candidates = [value.text, value.snippet, value.content, value.body, value.summary];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
};

const pickSnippetScore = (value: Record<string, unknown>) => {
  const raw = value.score;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const flattenCandidates = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = ['results', 'items', 'hits', 'data', 'matches'];
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return [];
};

export const parseQmdOutput = (output: string, minScore = 0): QmdSnippet[] => {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const parsedSnippets: QmdSnippet[] = [];
  const dedupe = new Set<string>();

  const pushSnippet = (candidate: QmdSnippet) => {
    const normalized = candidate.text.trim();
    if (!normalized) return;
    if (typeof candidate.score === 'number' && candidate.score < minScore) return;
    if (dedupe.has(normalized)) return;
    dedupe.add(normalized);
    parsedSnippets.push({
      text: normalized,
      score: candidate.score,
    });
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const items = flattenCandidates(parsed);
    for (const item of items) {
      if (typeof item === 'string') {
        pushSnippet({ text: item });
        continue;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushSnippet({
          text: pickSnippetText(record),
          score: pickSnippetScore(record),
        });
      }
    }
    if (parsedSnippets.length > 0 || items.length > 0) {
      return parsedSnippets;
    }
  } catch {
    // treat as plain text fallback
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const normalized = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (!normalized) continue;
    pushSnippet({ text: normalized });
  }
  return parsedSnippets;
};

