#!/usr/bin/env node

const payload = process.argv[2] ?? '';

const summary = payload && payload.trim() ? 'mock process engine turn complete' : 'mock process engine received empty payload';
const response = {
  summary,
  state: 'done',
};

process.stdout.write(`${JSON.stringify(response)}\n`);
