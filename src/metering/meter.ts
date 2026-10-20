import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CallRecord {
  runId: string;
  purpose: string;
  provider: string;
  model: string;
  attempt: number;
  success: boolean;
  errorKind?: string;
  fallback: boolean;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  step: number;
}

export interface CallRow {
  id: number;
  ts: number;
  run_id: string;
  purpose: string;
  provider: string;
  model: string;
  attempt: number;
  success: number;
  error_kind: string | null;
  fallback: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  step: number;
}

export interface MeterSink {
  record(call: CallRecord): void;
}

export const DEFAULT_DB_PATH = process.env.METER_DB ?? './data/meter.db';

export class Meter implements MeterSink {
  private db: Database.Database;

  constructor(
    path = DEFAULT_DB_PATH,
    private now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      success INTEGER NOT NULL,
      error_kind TEXT,
      fallback INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL,
      step INTEGER NOT NULL
    )`);
  }

  record(c: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls (ts, run_id, purpose, provider, model, attempt, success, error_kind, fallback,
           duration_ms, tokens_in, tokens_out, cost_usd, step)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(), c.runId, c.purpose, c.provider, c.model, c.attempt, c.success ? 1 : 0, c.errorKind ?? null,
        c.fallback ? 1 : 0, Math.round(c.durationMs), c.tokensIn, c.tokensOut, c.costUsd, c.step,
      );
  }

  rows(): CallRow[] {
    return this.db.prepare('SELECT * FROM calls ORDER BY id').all() as CallRow[];
  }

  close(): void {
    this.db.close();
  }
}
