export const DISCORD_CONTENT_HARD_LIMIT = 2000;

const findSafeSplitIndex = (segment: string) => {
  const paragraphBreaks = [...segment.matchAll(/\r?\n\r?\n/g)];
  const lastParagraphBreak = paragraphBreaks[paragraphBreaks.length - 1];
  if (lastParagraphBreak && typeof lastParagraphBreak.index === 'number' && lastParagraphBreak.index > 0) {
    return lastParagraphBreak.index + lastParagraphBreak[0].length;
  }

  const lineBreaks = [...segment.matchAll(/\r?\n/g)];
  const lastLineBreak = lineBreaks[lineBreaks.length - 1];
  if (lastLineBreak && typeof lastLineBreak.index === 'number' && lastLineBreak.index > 0) {
    return lastLineBreak.index + lastLineBreak[0].length;
  }

  const lastSpace = segment.lastIndexOf(' ');
  if (lastSpace > 0) {
    return lastSpace + 1;
  }

  return segment.length;
};

export const chunkDiscordContent = (content: string, limit = DISCORD_CONTENT_HARD_LIMIT): string[] => {
  if (limit <= 0) {
    throw new Error('discord_chunk_limit_invalid');
  }
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    const remaining = content.length - offset;
    if (remaining <= limit) {
      chunks.push(content.slice(offset));
      break;
    }

    const candidate = content.slice(offset, offset + limit);
    let splitIndex = findSafeSplitIndex(candidate);
    if (!Number.isFinite(splitIndex) || splitIndex <= 0 || splitIndex > candidate.length) {
      splitIndex = candidate.length;
    }

    chunks.push(content.slice(offset, offset + splitIndex));
    offset += splitIndex;
  }

  return chunks;
};

export const sendDiscordContentInChunks = async (
  content: string,
  sendChunk: (chunk: string, index: number, total: number) => Promise<void>,
  limit = DISCORD_CONTENT_HARD_LIMIT,
) => {
  const chunks = chunkDiscordContent(content, limit);
  for (let idx = 0; idx < chunks.length; idx += 1) {
    await sendChunk(chunks[idx], idx, chunks.length);
  }
  return {
    chunks: chunks.length,
    totalChars: content.length,
  };
};
