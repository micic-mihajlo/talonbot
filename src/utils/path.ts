import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const expandPath = (input: string) => {
  if (!input.startsWith('~')) return input;
  return input.replace(/^~(?=$|\/) , os.homedir());
};

export const ensureDir = async (input: string) => {
  await fs.mkdir(input, { recursive: true });
};

export const joinSafe = (...parts: string[]) => path.join(...parts.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_')));
