export const inferRequiresVerifiedPr = (text: string): boolean => {
  if (!text.trim()) {
    return false;
  }

  const explicitPrIntent = /\b(?:open|create|submit|raise|file)\s+(?:a\s+)?(?:pr|pull request)\b/i.test(text);
  if (explicitPrIntent) {
    return true;
  }

  const researchIntent = /\b(?:research(?:ing|ed)?|review(?:ing)?|summarize(?:d|s)?|inspect(?:ing|ed)?|analyz(?:e|es|ing|ed)|analysis|status(?:es)?|question(?:ing)?|investigat(?:e|ed|ing)|explain(?:ed)?|inspect(?:ed)?|audit(?:ed|ing)?)\b/i;
  if (researchIntent.test(text)) {
    return false;
  }

  const implementationIntent = /\b(?:implement(?:ing)?|build|create|add|modify|update|patch|refactor|remove|delete|deploy|setup|configure|wire|harden|migrate|fix|rewrite|improve|extend|introduce)\b/i;
  if (!implementationIntent.test(text)) {
    return false;
  }

  return true;
};

