// lib/env.js — minimal .env loader (zero dependencies).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load KEY=VALUE pairs from a .env file into process.env.
 * Existing environment variables are not overwritten.
 */
export function loadEnv(path = join(process.cwd(), '.env')) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] == null) process.env[key] = value;
  }
}
