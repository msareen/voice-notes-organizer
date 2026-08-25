import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

/**
 * A record of recordings deleted *through vno* - the UI's per-take delete, the
 * UI's cleanup, and `vno cleanup` - so a later import doesn't copy them back
 * off a device that still holds them. A file deleted by hand in Explorer or
 * Finder can't be seen from here and will come back on the next import.
 *
 * The ledger is entirely optional. Delete the file (or run `vno cleanup
 * ledger`) and every remembered deletion is forgotten: import goes straight
 * back to its old behaviour of copying anything that isn't already on disk.
 * A missing, unreadable or corrupt ledger is never an error, and nothing in
 * here ever touches a recording.
 */

const LEDGER_DIR = path.join(os.homedir(), ".vno");
const LEDGER_FILE = path.join(LEDGER_DIR, "deleted.json");

const README =
  "Recordings deleted through vno, so re-importing won't copy them back off a " +
  "device that still has them. Safe to delete this file (or run `vno cleanup " +
  "ledger`): that just forgets them, and the next import brings back anything " +
  "the device still holds. Entries are matched by target + path + byte size.";

/** One remembered deletion, as stored in deleted.json. */
export interface LedgerEntry {
  target: string;
  /** Target-relative, forward slashes. */
  rel: string;
  size: number | null;
  via: string;
  deletedAt: string;
}

/** What a caller hands `recordDeletions` for each removed recording. */
export interface DeletionItem {
  rel: string;
  size?: number | null;
  via?: string;
}

export interface LedgerSummary {
  path: string;
  exists: boolean;
  total: number;
  forTarget: number;
}

/** `(rel, size) -> was this deliberately deleted?` */
export type DeletionMatcher = (rel: string, size?: number | null) => boolean;

export function ledgerFilePath(): string {
  return LEDGER_FILE;
}

/**
 * Entries are matched on the same pair import already uses to decide a file is
 * already there: its target-relative path and its byte size. A null size (we
 * couldn't stat the file before removing it) matches any size for that path.
 */
function keyFor(rel: string, size: number | null | undefined): string {
  return `${rel} ${size ?? "*"}`;
}

/** Windows paths differ only by case; everywhere else they're compared as-is. */
function sameTarget(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = path.resolve(a || "");
  const right = path.resolve(b || "");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Reads every entry in the ledger. Missing, unreadable and corrupt all mean
 * the same thing here - nothing is remembered - because a bookkeeping file
 * must never be able to block an import.
 */
export async function readLedger(): Promise<LedgerEntry[]> {
  try {
    const data = await fs.readJson(LEDGER_FILE);
    return Array.isArray(data?.entries)
      ? (data.entries as unknown[]).filter(
          (e): e is LedgerEntry => !!e && typeof (e as LedgerEntry).rel === "string"
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Builds the `(rel, size) -> boolean` test import uses to leave a deliberately
 * deleted recording alone. Reads the file once; returns a test that's always
 * false when the ledger is off, absent or empty, so the caller needs no
 * special case for "no ledger".
 */
export async function loadDeletionMatcher(
  target: string,
  { enabled = true }: { enabled?: boolean } = {}
): Promise<DeletionMatcher> {
  if (!enabled) return () => false;

  const entries = (await readLedger()).filter((e) => sameTarget(e.target, target));
  if (entries.length === 0) return () => false;

  const exact = new Set<string>();
  const anySize = new Set<string>();
  for (const entry of entries) {
    if (entry.size === null || entry.size === undefined) anySize.add(entry.rel);
    else exact.add(keyFor(entry.rel, entry.size));
  }

  return (rel, size) => anySize.has(rel) || exact.has(keyFor(rel, size));
}

/**
 * Appends deletions, skipping ones already remembered. `items` are
 * `{ rel, size, via }`, where `rel` is target-relative with forward slashes.
 * Returns how many entries were actually added.
 *
 * Failures are swallowed on purpose: the recording is already gone by the time
 * this runs, and losing the bookkeeping is a far smaller problem than turning
 * a successful delete into an error.
 */
export async function recordDeletions(
  target: string,
  items: DeletionItem[] | null | undefined,
  { enabled = true }: { enabled?: boolean } = {}
): Promise<number> {
  if (!enabled) return 0;

  const incoming = (items || []).filter((item) => item && typeof item.rel === "string" && item.rel);
  if (incoming.length === 0) return 0;

  const entries = await readLedger();
  const seen = new Set(
    entries.filter((e) => sameTarget(e.target, target)).map((e) => keyFor(e.rel, e.size))
  );

  const added: LedgerEntry[] = [];
  for (const { rel, size, via } of incoming) {
    const key = keyFor(rel, size);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      target: path.resolve(target),
      rel,
      size: size ?? null,
      via: via || "delete",
      deletedAt: new Date().toISOString(),
    });
  }
  if (added.length === 0) return 0;

  try {
    await fs.ensureDir(LEDGER_DIR);
    await fs.writeJson(
      LEDGER_FILE,
      { version: 1, _readme: README, entries: entries.concat(added) },
      { spaces: 2 }
    );
  } catch {
    return 0;
  }
  return added.length;
}

/** Counts for the settings screen: how much is remembered, and where. */
export async function ledgerSummary(target?: string | null): Promise<LedgerSummary> {
  const exists = await fs.pathExists(LEDGER_FILE);
  const entries = exists ? await readLedger() : [];
  return {
    path: LEDGER_FILE,
    exists,
    total: entries.length,
    forTarget: target ? entries.filter((e) => sameTarget(e.target, target)).length : entries.length,
  };
}

/**
 * Removes the ledger file outright - exactly what deleting it by hand does.
 * Returns whether there was anything to remove.
 */
export async function clearLedger(): Promise<boolean> {
  if (!(await fs.pathExists(LEDGER_FILE))) return false;
  await fs.remove(LEDGER_FILE);
  return true;
}
