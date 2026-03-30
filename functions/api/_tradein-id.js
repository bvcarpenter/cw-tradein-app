/**
 * Generate a unique Trade-In Session ID.
 *
 * Format: CWTI-YYMMDD-XXXX
 *   CWTI   — Camera West Trade-In prefix
 *   YYMMDD — date (year, month, day)
 *   XXXX   — 4-char alphanumeric random suffix (uppercase, no ambiguous chars)
 *
 * Example: CWTI-260330-A7K2
 */
export function generateTradeInId(date) {
  const d = date ? new Date(date) : new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  // Alphanumeric chars excluding ambiguous ones (0/O, 1/I/L)
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let suffix = '';
  const rand = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) {
    suffix += chars[rand[i] % chars.length];
  }

  return `CWTI-${yy}${mm}${dd}-${suffix}`;
}
