import { describe, expect, it } from 'vitest';

import { getD1ExportFile, isD1ExportResponse } from '~/server/workflows/backupProtocol';

describe('D1 export response', () => {
  it('reads the signed download URL from the nested completed result', () => {
    const file = getD1ExportFile({
      status: 'complete',
      result: {
        filename: 'splitpro.sql',
        signed_url: 'https://example.com/splitpro.sql',
      },
    });

    expect(file).toEqual({
      filename: 'splitpro.sql',
      signed_url: 'https://example.com/splitpro.sql',
    });
  });

  it('returns no file while the export is still running', () => {
    expect(getD1ExportFile({ at_bookmark: 'bookmark' })).toBeUndefined();
  });

  it('accepts the complete API response shape and rejects malformed nested file data', () => {
    expect(
      isD1ExportResponse({
        success: true,
        result: {
          status: 'complete',
          result: { filename: 'splitpro.sql', signed_url: 'https://example.com/splitpro.sql' },
        },
      }),
    ).toBe(true);
    expect(
      isD1ExportResponse({
        success: true,
        result: { status: 'complete', result: { signed_url: 42 } },
      }),
    ).toBe(false);
  });
});
