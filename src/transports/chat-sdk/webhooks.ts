import type { IncomingHttpHeaders } from 'node:http';

const toHeaderRecord = (headers: IncomingHttpHeaders) => {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) output.append(key, entry);
      continue;
    }
    if (typeof value === 'string') {
      output.set(key, value);
    }
  }
  return output;
};

export const toWebhookRequest = (url: string, method: string, headers: IncomingHttpHeaders, rawBody: Buffer): Request =>
  new Request(url, {
    method,
    headers: toHeaderRecord(headers),
    body: rawBody,
  });

export const fromWebhookResponse = async (response: Response) => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers,
    body: await response.text(),
  };
};
