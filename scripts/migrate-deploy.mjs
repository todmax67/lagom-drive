#!/usr/bin/env node
/**
 * Applica le migration Prisma SOLO durante i build di Production su Vercel.
 *
 * Perché il guard: DATABASE_URL e DATABASE_URL_UNPOOLED hanno lo stesso valore
 * per Production, Preview e Development, quindi puntano tutte al database Neon
 * di produzione. Senza guard ogni push su un branch con PR aperta applicherebbe
 * le sue migration alla produzione prima della review — e non tutte sono
 * additive: 20260417000000_add_trip_volvo_crosscheck contiene un UPDATE che
 * riscrive righe di Settings.
 *
 * Neon va in cold start: la prima connessione può fallire. Si riprova solo
 * sugli errori di raggiungibilità, mai su un errore SQL reale — quello deve
 * fermare il build e impedire la promozione del deploy.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_PRISMA = path.join(ROOT, 'node_modules', '.bin', 'prisma');
const HAS_LOCAL_PRISMA = existsSync(LOCAL_PRISMA);
const CMD = HAS_LOCAL_PRISMA ? LOCAL_PRISMA : 'npx';
const ARGS = HAS_LOCAL_PRISMA ? ['migrate', 'deploy'] : ['prisma', 'migrate', 'deploy'];

const BACKOFF_MS = [3_000, 6_000, 12_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const RETRYABLE =
  /P1001|P1002|P1017|Can't reach database server|Timed out|Server has closed the connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

if (process.env.VERCEL_ENV !== 'production') {
  console.log(
    `[migrate] VERCEL_ENV=${process.env.VERCEL_ENV ?? '(assente)'}: migration NON applicate.`
  );
  console.log(
    '[migrate] Preview e Development condividono il database Neon di Production: ' +
      'per applicarle a mano usa `npm run migrate:deploy`.'
  );
  process.exit(0);
}

if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error('[migrate] DATABASE_URL_UNPOOLED assente: build interrotto.');
  process.exit(1);
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const res = spawnSync(CMD, ARGS, { encoding: 'utf8' });

  if (res.error) {
    console.error(`[migrate] impossibile eseguire prisma: ${res.error.message}`);
    process.exit(1);
  }

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  process.stdout.write(out);

  if (res.status === 0) {
    console.log('[migrate] migration applicate.');
    process.exit(0);
  }

  if (attempt < MAX_ATTEMPTS && RETRYABLE.test(out)) {
    const wait = BACKOFF_MS[attempt - 1];
    console.log(
      `[migrate] database non raggiungibile (cold start Neon?): retry ${attempt}/${MAX_ATTEMPTS - 1} fra ${wait}ms`
    );
    await new Promise(resolve => setTimeout(resolve, wait));
    continue;
  }

  if (/P3009/.test(out)) {
    console.error(
      '[migrate] Nel DB risulta una migration in stato failed: risolvila con ' +
        '`prisma migrate resolve --rolled-back <nome_migration>` prima di ridiployare.'
    );
  }
  console.error('[migrate] FALLITO: build interrotto, il deploy non viene promosso.');
  process.exit(res.status ?? 1);
}
