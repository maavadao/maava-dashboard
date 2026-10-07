/**
 * Tiny client-side CSV exporter used by the products page bulk action.
 * Pulled out into its own module so it can be reused by other list pages
 * (orders, agents, conversations) without dragging chart/table libraries
 * along for the ride.
 */

export type CsvCell = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvCell>;

/**
 * Quote a single CSV cell per RFC 4180:
 *   • wrap in double quotes when the value contains comma, quote, or newline
 *   • escape embedded double quotes by doubling them
 */
function quote(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert an array of plain objects into a CSV string. Column order is the
 * union of every key in the row set, preserving first-seen order.
 */
export function rowsToCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return '';
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const lines: string[] = [headers.map(quote).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => quote(row[h])).join(','));
  }
  // CRLF terminator is the spec-correct line ending for CSV.
  return lines.join('\r\n');
}

/**
 * Trigger a browser download of the given CSV string. Safe to call from
 * event handlers — uses an in-memory blob URL that's revoked on the next
 * tick.
 */
export function downloadCsv(filename: string, csv: string): void {
  // BOM ensures Excel treats the file as UTF-8 instead of Latin-1.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
