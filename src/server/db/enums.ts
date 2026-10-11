// Dependency-free so client components can import it without pulling in drizzle-orm.
export const SplitType = {
  EQUAL: 'EQUAL',
  PERCENTAGE: 'PERCENTAGE',
  EXACT: 'EXACT',
  SHARE: 'SHARE',
  ADJUSTMENT: 'ADJUSTMENT',
  SETTLEMENT: 'SETTLEMENT',
  CURRENCY_CONVERSION: 'CURRENCY_CONVERSION',
} as const;
export type SplitType = (typeof SplitType)[keyof typeof SplitType];
