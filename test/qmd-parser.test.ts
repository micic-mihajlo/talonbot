import { describe, expect, it } from 'vitest';
import { parseQmdOutput } from '../src/memory/providers/qmd-parser.js';

describe('qmd parser', () => {
  it('parses JSON snippet arrays and applies score threshold', () => {
    const raw = JSON.stringify({
      results: [
        { text: 'keep this', score: 0.9 },
        { text: 'drop this', score: 0.1 },
      ],
    });
    const snippets = parseQmdOutput(raw, 0.5);
    expect(snippets.map((item) => item.text)).toEqual(['keep this']);
  });

  it('deduplicates text fallback lines', () => {
    const raw = '- same\n- same\n- different';
    const snippets = parseQmdOutput(raw);
    expect(snippets.map((item) => item.text)).toEqual(['same', 'different']);
  });
});

