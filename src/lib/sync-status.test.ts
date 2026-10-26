import { describe, expect, it } from 'vitest'
import { STALE_DAYS, syncStatus, type SyncAccount } from './sync-status'

// What a Member and the Admin read above the Balances table. The things worth pinning: it turns red after two days, it names a
// cause for each way Sync can fail, only the Admin is told what to do, and an app with no Akahu Account has no status at all.

const NOW = new Date('2026-10-20T06:00:00.000Z')
/** Yesterday, so an Account that synced then is current. */
const YESTERDAY = '2026-10-19T18:00:00.000Z'

const linked = (over: Partial<SyncAccount> = {}): SyncAccount => ({
  name: 'Everyday',
  akahuAccountId: 'acc_linked000000000000001',
  akahuSyncedAt: YESTERDAY,
  akahuMissingSince: null,
  akahuLastFailure: null,
  akahuConnectionName: 'Kiwibank',
  ...over,
})

const unlinked = (over: Partial<SyncAccount> = {}): SyncAccount => linked({ akahuAccountId: null, akahuSyncedAt: null, akahuConnectionName: null, ...over })

const asAdmin = (accounts: SyncAccount[], now = NOW) => syncStatus(accounts, now, 'admin')
const asMember = (accounts: SyncAccount[], now = NOW) => syncStatus(accounts, now, 'member')

describe('the Sync status', () => {
  it('has nothing to say when no Account is linked to Akahu', () => {
    expect(asAdmin([unlinked(), unlinked({ name: 'Savings' })])).toBeNull()
  })

  it('says when the data was last updated, and is a success while it is current', () => {
    expect(asAdmin([linked()])).toEqual({ tone: 'success', text: 'Bank data last updated Tue 20 Oct 2026 at 7:00 am.' })
  })

  it('takes the oldest Account, so it never claims to be more current than the slowest', () => {
    const status = asAdmin([linked({ akahuSyncedAt: '2026-10-20T05:00:00.000Z' }), linked({ name: 'Savings', akahuSyncedAt: YESTERDAY })])
    expect(status!.text).toBe('Bank data last updated Tue 20 Oct 2026 at 7:00 am.')
  })

  it('waits for the first Sync rather than claiming an update, where no Account has ever synced', () => {
    expect(asAdmin([linked({ akahuSyncedAt: null })])).toEqual({ tone: 'neutral', text: 'Waiting for the first Sync of this Account.' })
    expect(asAdmin([linked({ akahuSyncedAt: null }), linked({ name: 'Savings', akahuSyncedAt: null })])!.text).toBe('Waiting for the first Sync of these Accounts.')
  })

  // The review of this ticket found a newly linked Account hid every other Account's staleness: `oldest` went null, so the line
  // dropped the time and the tone never turned red. An Account waiting for its first Sync says so beside the time, and nothing more.
  it('still dates the data, and still turns red, when one Account has never synced', () => {
    const status = asAdmin([linked({ akahuSyncedAt: '2026-10-17T05:00:00.000Z' }), linked({ name: 'New', akahuSyncedAt: null })])
    expect(status!.tone).toBe('danger')
    expect(status!.text).toBe('Bank data last updated Sat 17 Oct 2026 at 6:00 pm. One Account is waiting for a first Sync.')
    expect(status!.cause).toBe('No Sync has finished for 3 days, so this may be out of date.')
  })

  it('counts the Accounts that are waiting, and says so without claiming they are stale', () => {
    const status = asAdmin([linked(), linked({ name: 'New', akahuSyncedAt: null }), linked({ name: 'Newer', akahuSyncedAt: null })])
    expect(status!.tone).toBe('success')
    expect(status!.text).toBe('Bank data last updated Tue 20 Oct 2026 at 7:00 am. 2 Accounts are waiting for a first Sync.')
  })

  // Spec 59 asks the cause to be named, and an Account the run could not start is a cause like any other: without this it read
  // as merely stale, with nothing to act on.
  it('names an Account with no Cutover Date, and what the Admin does about it', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'no-window' })])
    expect(status!.cause).toBe('Kiwibank has no Cutover Date, so Sync leaves it alone.')
    expect(status!.action).toBe('Import a bank file for it to set its Cutover Date, then run a Sync.')
  })

  it('says when the run has not reached an Account yet, as a warning and not a fault', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'no-budget' })])
    expect(status!.tone).toBe('warning')
    expect(status!.cause).toBe('Sync has not reached Kiwibank yet: a run takes four Accounts, and it comes first in the next one.')
    expect(status!.action).toBe('The next Sync takes it first. Run a Sync now if you would rather not wait.')
  })

  it('says when an Account is catching up on a long gap, and that running a Sync carries it on', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'catching-up' })])
    expect(status!.cause).toBe('Kiwibank is catching up on a long gap: a Sync reads two months of it at a time.')
    expect(status!.action).toBe('The next Sync carries on. Run a Sync now to catch up sooner.')
  })

  it('reads a Link the Worker marked broken the same as one Akahu has stopped listing', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'link-broken' })])
    expect(status!.cause).toContain('needs reconnecting in Akahu')
  })

  it(`turns red after ${STALE_DAYS} days without a Sync that finished, and says how long it has been`, () => {
    const current = asAdmin([linked({ akahuSyncedAt: '2026-10-19T06:00:00.000Z' })])
    expect(current!.tone).toBe('success')
    const stale = asAdmin([linked({ akahuSyncedAt: '2026-10-18T05:00:00.000Z' })])
    expect(stale!.tone).toBe('danger')
    expect(stale!.cause).toBe('No Sync has finished for 2 days, so this may be out of date.')
    expect(stale!.action).toBe('Run a Sync. If it fails, the reason is shown with it.')
  })

  it('names a broken Account Link by its bank, and says no Transaction was removed', () => {
    const status = asAdmin([linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z' })])
    expect(status!.tone).toBe('danger')
    expect(status!.cause).toBe('Kiwibank needs reconnecting in Akahu: Akahu has stopped listing that account. No Transaction has been removed.')
    expect(status!.action).toBe('Reconnect it in Akahu, then link the Account again in Settings.')
  })

  it('names every bank whose Link is broken, without repeating one', () => {
    const status = asAdmin([
      linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z' }),
      linked({ name: 'Savings', akahuMissingSince: '2026-10-19T18:00:00.000Z' }),
      linked({ name: 'Card', akahuMissingSince: '2026-10-19T18:00:00.000Z', akahuConnectionName: 'ASB' }),
    ])
    expect(status!.cause).toContain('Kiwibank and ASB need reconnecting in Akahu')
  })

  it('falls back to the Account name where Akahu has not said which bank it is', () => {
    const status = asAdmin([linked({ akahuConnectionName: null, akahuMissingSince: '2026-10-18T18:00:00.000Z' })])
    expect(status!.cause).toContain('Everyday needs reconnecting in Akahu')
  })

  it('puts a broken Link before a failure, because nothing else comes right until it is re-linked', () => {
    const status = asAdmin([linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z', akahuLastFailure: 'unreachable' })])
    expect(status!.cause).toContain('needs reconnecting in Akahu')
  })

  it('calls refused tokens what they are, and sends the Admin to Settings', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'refused' })])
    expect(status!.tone).toBe('danger')
    expect(status!.cause).toBe('Akahu token invalid: Akahu refused the tokens, so nothing could be read.')
    expect(status!.action).toBe('Check both tokens in Akahu, set them again in Settings, then run a Sync.')
  })

  it('takes refused tokens as the worst cause when Accounts failed in different ways', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'unreachable' }), linked({ name: 'Savings', akahuLastFailure: 'refused' })])
    expect(status!.cause).toContain('Akahu token invalid')
  })

  it('is a warning while Akahu is merely unavailable, and promises no retry but the next Sync', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'unreachable' })])
    expect(status!.tone).toBe('warning')
    expect(status!.cause).toBe('Akahu unavailable for Kiwibank: it could not be reached, or took too long.')
    expect(status!.action).toBe('The next Sync will try again. Run a Sync now if you would rather not wait.')
  })

  it('turns an unavailable Akahu red once the data is stale as well', () => {
    expect(asAdmin([linked({ akahuSyncedAt: '2026-10-18T05:00:00.000Z', akahuLastFailure: 'unreachable' })])!.tone).toBe('danger')
  })

  it('says so when Akahu answered with something that was not Transactions', () => {
    const status = asAdmin([linked({ akahuLastFailure: 'unreadable' })])
    expect(status!.tone).toBe('danger')
    expect(status!.cause).toBe('Akahu answered, but not with Transactions, for Kiwibank.')
  })

  it('tells a Member the state and the cause, and never what only the Admin can do', () => {
    for (const account of [
      linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z' }),
      linked({ akahuLastFailure: 'refused' }),
      linked({ akahuLastFailure: 'unreachable' }),
      linked({ akahuLastFailure: 'unreadable' }),
      linked({ akahuSyncedAt: '2026-10-17T05:00:00.000Z' }),
    ]) {
      const member = asMember([account])
      expect(member!.cause).toBe(asAdmin([account])!.cause)
      expect(member!.action).toBeUndefined()
    }
  })

  // An answer from before these fields were stored, or one written by hand, leaves them undefined. Nothing is wrong with such an
  // Account, and an undefined time must never be shown as a date either (which threw on the Accounts screen once).
  it('takes an answer without the new fields as an Account with nothing wrong', () => {
    const older = { name: 'Everyday', akahuAccountId: 'acc_linked000000000000001', akahuSyncedAt: YESTERDAY } as unknown as SyncAccount
    expect(asAdmin([older])).toEqual({ tone: 'success', text: 'Bank data last updated Tue 20 Oct 2026 at 7:00 am.' })
  })

  it('does not date the status from a value that is not a moment', () => {
    expect(asAdmin([linked({ akahuSyncedAt: 'whenever' })])).toEqual({ tone: 'neutral', text: 'Waiting for the first Sync of this Account.' })
  })

  it('ignores an Account that is not linked, whatever is stored against it', () => {
    expect(asAdmin([linked(), unlinked({ akahuLastFailure: 'refused', akahuMissingSince: '2026-10-01T00:00:00.000Z' })])).toEqual({
      tone: 'success',
      text: 'Bank data last updated Tue 20 Oct 2026 at 7:00 am.',
    })
  })
})
