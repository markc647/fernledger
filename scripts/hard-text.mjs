// Text a restore is likeliest to get wrong, for the restore tests (scripts/backup-restore.test.mjs) and the practice run on Cloudflare
// (scripts/restore-practice.mjs). Wrangler edits a --file as plain text before running it, so these are the kinds of text it could reach: its own
// transaction words, statement and comment syntax, quotes, line breaks, control characters, every ASCII character and some that aren't.
// Each goes as hex or as a quoted literal (worker/backup-format.ts), so both are here.
export const HARD_TEXTS = [
  'REF COMMIT; PAYEE',
  'BEGIN TRANSACTION; DUMMY',
  'BEGIN TRANSACTION',
  'begin transaction; commit;',
  "O'Brien \"quoted\"; DROP TABLE settings; -- /* not a comment */",
  'Line one\r\nLine two\rLine three\n',
  'NUL\u0000inside, and a bell\u0007',
  'EXAMPLE LINE\n'.repeat(50), // 50 line breaks: as || char(10) || terms, past SQLite's expression depth of 100
  'EXAMPLE LINE\r\n'.repeat(40),
  'Café ☕ Māori ā 𝄞',
  Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join(''), // every ASCII character, NUL included
  '',
]
