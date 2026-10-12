export interface D1ExportFile {
  filename?: string;
  signed_url?: string;
}

export interface D1ExportResult {
  status?: 'complete' | 'error';
  at_bookmark?: string;
  error?: string;
  result?: D1ExportFile;
}

export interface D1ExportResponse {
  success?: boolean;
  errors?: { message: string }[];
  result?: D1ExportResult | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  null !== value && 'object' === typeof value;

const isOptionalString = (value: unknown) => undefined === value || 'string' === typeof value;

const isD1ExportFile = (value: unknown): value is D1ExportFile =>
  isRecord(value) && isOptionalString(value.filename) && isOptionalString(value.signed_url);

const isD1ExportResult = (value: unknown): value is D1ExportResult =>
  isRecord(value) &&
  (undefined === value.status || 'complete' === value.status || 'error' === value.status) &&
  isOptionalString(value.at_bookmark) &&
  isOptionalString(value.error) &&
  (undefined === value.result || isD1ExportFile(value.result));

export const isD1ExportResponse = (value: unknown): value is D1ExportResponse =>
  isRecord(value) &&
  (undefined === value.success || 'boolean' === typeof value.success) &&
  (undefined === value.errors ||
    (Array.isArray(value.errors) &&
      value.errors.every((error) => isRecord(error) && 'string' === typeof error.message))) &&
  (undefined === value.result || null === value.result || isD1ExportResult(value.result));

/** The API nests the completed file metadata inside result.result. */
export const getD1ExportFile = (result: D1ExportResult) => result.result;
