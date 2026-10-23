import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, isoDate } from './account-fields'
import { CLEAR_DETAILS, SELECT_DISPLAYED, toAttributeWords } from './akahu-details'
import type { DisplayedDetails } from './akahu-details'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import type { SyncFailure } from './sync'
import { DELETE_PENDING_ON_RELINK } from './pending'
import { CHANGED_MEANWHILE, pathId, validate } from './validate'

// What Akahu said about a linked Account is null for one that is not linked, and until a Sync has read it (worker/akahu-details.ts).
// `akahuSyncedAt` is when Sync last finished the Account (an instant in UTC), or null until it has.
// `akahuMissingSince` is when Akahu first stopped listing the Account ("Account Link broken"), and `akahuLastFailure` why the last
// Sync of it did not finish; both are null when there is nothing wrong. The Sync status is written from them (src/lib/sync-status.ts).
type AccountRow = {
  id: number
  name: string
  accountNumber: string
  cutoverDate: string | null
  akahuAccountId: string | null
  akahuSyncedAt: string | null
  akahuMissingSince: string | null
  akahuLastFailure: SyncFailure | null
} & {
  [K in keyof DisplayedDetails]: DisplayedDetails[K] | null
}

/** One Account as the browser gets it: the row, with Akahu's attributes as the words they are rather than the JSON the column holds. */
type Account = Omit<AccountRow, 'akahuAttributes'> & { akahuAttributes: string[] | null }

const rename = z.object({ name: accountName })
const cutover = z.object({ cutoverDate: z.nullable(isoDate) })
// Akahu's own account ID, which is opaque: its shape is all that can be checked, and the link is only as good as the Admin's choice
// from /api/akahu/accounts. Null unlinks the Account.
const link = z.object({ akahuAccountId: z.nullable(z.string().check(z.regex(/^acc_[A-Za-z0-9]{1,64}$/))) })

export const accounts = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, account_number AS accountNumber, cutover_date AS cutoverDate, akahu_account_id AS akahuAccountId, akahu_synced_at AS akahuSyncedAt,
              akahu_missing_since AS akahuMissingSince, akahu_last_failure AS akahuLastFailure, ${SELECT_DISPLAYED}
       FROM accounts ORDER BY name COLLATE NOCASE, id`,
    ).all<AccountRow>()
    return c.json(results.map(({ akahuAttributes, ...account }): Account => ({ ...account, akahuAttributes: toAttributeWords(akahuAttributes) })))
  })
  .patch('/:id', validate('json', rename), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const { name } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(id).first<{ name: string }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    if (account.name === name) return c.json({ id, name })

    // Only over the name that was read, and an entry only if it changed something (`onlyIfChanged`): another request can land between the read and the write, and the
    // Change Log must not say the Account was renamed from a name it no longer had.
    const [update] = await recordChange(db, db.prepare('UPDATE accounts SET name = ?1 WHERE id = ?2 AND name = ?3').bind(name, id, account.name), {
      actor: c.var.member,
      type: 'account',
      summary: `Renamed Account ${account.name} to ${name}`,
      before: { name: account.name },
      after: { name },
      onlyIfChanged: true,
    })
    if (update!.meta.changes === 0) {
      const now = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(id).first<{ name: string }>()
      if (!now) return c.json({ error: 'Not found' }, 404)
      return now.name === name ? c.json({ id, name }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id, name })
  })
  // The Cutover Date (ADR 0003): Import drops rows dated on or after it. Setting it deletes nothing already saved.
  .put('/:id/cutover-date', validate('json', cutover), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const { cutoverDate } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name, cutover_date FROM accounts WHERE id = ?').bind(id).first<{ name: string; cutover_date: string | null }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    if (account.cutover_date === cutoverDate) return c.json({ id, cutoverDate })

    // As the rename is: only over the date that was read (`IS` is `=` that also matches NULL), and an entry only if it changed something.
    const [update] = await recordChange(db, db.prepare('UPDATE accounts SET cutover_date = ?1 WHERE id = ?2 AND cutover_date IS ?3').bind(cutoverDate, id, account.cutover_date), {
      actor: c.var.member,
      type: 'account',
      summary: cutoverDate === null ? `Cleared the Cutover Date for ${account.name}` : `Set the Cutover Date for ${account.name} to ${cutoverDate}`,
      before: { cutoverDate: account.cutover_date },
      after: { cutoverDate },
      onlyIfChanged: true,
    })
    if (update!.meta.changes === 0) {
      const now = await db.prepare('SELECT cutover_date FROM accounts WHERE id = ?').bind(id).first<{ cutover_date: string | null }>()
      if (!now) return c.json({ error: 'Not found' }, 404)
      return now.cutover_date === cutoverDate ? c.json({ id, cutoverDate }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id, cutoverDate })
  })
  // The Account Link (spec 29): which Akahu account this Account receives Sync from, or null to stop syncing it. Only linked
  // Accounts are ever synced (ADR 0008), and unlinking deletes no Transaction: what Sync already brought in stays. What Akahu said about
  // the old link (the bank, the balance, ...) goes in the same write, because it describes an account this one no longer takes from.
  .put('/:id/akahu-link', validate('json', link), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const { akahuAccountId } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name, akahu_account_id FROM accounts WHERE id = ?').bind(id).first<{ name: string; akahu_account_id: string | null }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    if (account.akahu_account_id === akahuAccountId) return c.json({ id, akahuAccountId })
    // One Akahu account feeds at most one Account (the unique index in migration 2701), so say which Account has it rather than
    // letting the write fail. Another request could still take it between this read and the write; that surfaces as the 409 below.
    if (akahuAccountId !== null) {
      const taken = await db.prepare('SELECT name FROM accounts WHERE akahu_account_id = ? AND id <> ?').bind(akahuAccountId, id).first<{ name: string }>()
      if (taken) return c.json({ error: `That Akahu account is already linked to ${taken.name}` }, 409)
    }

    // As the Cutover Date is: only over the link that was read (`IS` is `=` that also matches NULL), and an entry only if it changed something.
    // The Pending Transactions came from the old link and say nothing about the new one, so they go with it, in the same batch:
    // an unlink that committed without them would leave pending money showing for an Account no Sync will ever replace it for.
    // Two statements, the update second: the Change Log entry counts `changes()` of the statement just before it, and that has
    // to be the update (worker/changelog.ts). `recordChange` hands the results back in the order given.
    const [, update] = await recordChange(
      db,
      [
        db.prepare(DELETE_PENDING_ON_RELINK).bind(id, account.akahu_account_id),
        db.prepare(`UPDATE accounts SET akahu_account_id = ?1, ${CLEAR_DETAILS} WHERE id = ?2 AND akahu_account_id IS ?3`).bind(akahuAccountId, id, account.akahu_account_id),
      ],
      {
      actor: c.var.member,
      type: 'account',
      // Akahu's ID is not in the summary: the Change Log is read by Members, and which Akahu account it is says nothing to them.
      summary: akahuAccountId === null ? `Unlinked ${account.name} from Akahu` : `Linked ${account.name} to an Akahu account`,
      before: { akahuAccountId: account.akahu_account_id },
      after: { akahuAccountId },
      onlyIfChanged: true,
      },
    )
    if (update!.meta.changes === 0) {
      const now = await db.prepare('SELECT akahu_account_id FROM accounts WHERE id = ?').bind(id).first<{ akahu_account_id: string | null }>()
      if (!now) return c.json({ error: 'Not found' }, 404)
      return now.akahu_account_id === akahuAccountId ? c.json({ id, akahuAccountId }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id, akahuAccountId })
  })
