/**
 * Shared Supabase service-role key loader, used by every PvP script that
 * writes (run-round, reset-round, advance-round). tsx does not auto-load a
 * .env file, so this is a minimal hand-rolled reader: prefer the real env var
 * (set by CI as the SUPABASE_SERVICE_ROLE_KEY secret), otherwise look for a
 * repo-root .env (Jesper's local setup; gitignored, never commit or ship it).
 *
 * Returns undefined if no key is found — every caller treats that as "run in
 * dry-run / preview mode", never as a hard error, so these scripts stay safe
 * to run with no credentials at hand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function serviceKey(): string | undefined {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  for (const p of ['.env', '../.env', '../../.env']) {
    try {
      const txt = readFileSync(join(process.cwd(), p), 'utf8');
      const m = txt.match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)\s*$/m);
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
      /* no file here — try the next */
    }
  }
  return undefined;
}
