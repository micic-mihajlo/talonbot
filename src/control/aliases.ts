export interface SessionAlias {
  alias: string;
  sessionKey: string;
  createdAt: string;
}

export type AliasMap = Record<string, SessionAlias>;

const ALIAS_PATTERN = /^[a-z0-9._-]+$/i;

export const normalizeAlias = (value: string) => value.trim().toLowerCase();

export const isValidAlias = (value: string) => {
  const normalized = normalizeAlias(value);
  return normalized.length > 0 && normalized.length <= 64 && ALIAS_PATTERN.test(normalized);
};
