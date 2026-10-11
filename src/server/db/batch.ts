import type { BatchItem } from 'drizzle-orm/batch';

import { getDb } from './index';

/**
 * Runs statements in one D1 batch. D1 executes a batch as a single SQL transaction:
 * if any statement fails, every statement in the batch is rolled back.
 */
export const runBatch = async (items: BatchItem<'sqlite'>[]): Promise<unknown[]> => {
  if (0 === items.length) {
    return [];
  }
  return getDb().batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
};

/**
 * D1 allows at most 100 bound parameters per statement. Use this to split multi-row
 * inserts: `chunk(rows, Math.floor(100 / columnsPerRow))`.
 */
export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};
