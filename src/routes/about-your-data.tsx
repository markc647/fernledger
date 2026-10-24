import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Status } from '@/components/status'
import { contactLine, retentionLine, type SettingLine } from '@/lib/about-data'
import { featuresQuery } from '@/lib/features'
import { meQuery } from '@/lib/me'
import { settingsQuery } from '@/lib/settings'

export const Route = createFileRoute('/about-your-data')({
  component: AboutYourData,
  staticData: { nav: { label: 'About your data', group: 'help', order: 85 } },
})

/**
 * What Fernledger holds, who sees it, where it is kept, for how long and who to ask. Every Member can read it.
 * It states what the app does (the schema, README "Security and privacy", ADR 0002, 0007 and 0010) and takes only the
 * contact and retention from Settings. docs/privacy.md has the law and the sources; this page doesn't repeat them.
 * Oceania is a location hint, never a residency guarantee (ADR 0007).
 */
function AboutYourData() {
  const { data: me, isError: meFailed } = useQuery(meQuery)
  const { data: settings, isError: settingsFailed } = useQuery(settingsQuery)
  const { data: features, isPending: featuresPending } = useQuery(featuresQuery)
  const akahu = features?.find((feature) => feature.id === 'akahu-sync')
  // 'on' and 'off' are what the Worker said; 'unknown' is when it could not say. The promise below is not written until it has said one or the other.
  const usageFigures = !features ? 'unknown' : features.find((feature) => feature.id === 'd1-usage')?.enabled === true ? 'on' : 'off'
  // Until both have arrived there is nothing to show for the two Settings: a Member must not read the neutral line
  // for a moment before the Admin's own words replace it, and the Admin's guidance needs the role.
  const ready = me && settings
  // The role decides which words the Settings lines use, so a failure of either query stops them being shown. (The root
  // layout already replaces the page when `/api/me` fails; this keeps the page honest if that ever changes.)
  const failed = settingsFailed || meFailed
  return (
    <article className="max-w-2xl text-base leading-relaxed print:text-[13.5pt]">
      <h1 className="text-2xl font-semibold">About your data</h1>
      <p className="mt-3">
        This page explains how Fernledger handles the financial information in it: what it holds, who can see it, where it is kept, for how long, and who to ask.
      </p>

      <Section id="held" title="What is held">
        <ul className="list-disc space-y-2 ps-6">
          <li>
            <strong className="font-semibold">Accounts:</strong> each tracked bank Account's name and number, or, for an Account whose bank prints no number such as a credit card, the key Fernledger gives it instead. If this Fernledger uses Akahu Sync, an Account linked to Akahu also holds what Akahu says about it: its own name for the
            account, the account number as Akahu formats it, its status and type, Akahu's attributes for it, the bank's name, the balance it reports (with the currency) and when Akahu last read the bank for each part, the bank connection it came from and of what kind, and when Fernledger last Synced the Account (its Last Sync). A linked Account also holds why the last Sync of it did not finish, and since when Akahu has stopped listing it (its Account Link broken); both are cleared once a Sync of it finishes or Akahu lists it again, and no Transaction is ever removed because of them. Akahu also gives a web address for the bank's logo. Fernledger keeps the address and nothing else:
            it never fetches or shows the logo, so nobody's browser contacts Akahu for it. Unlinking an Account clears all of this.
          </li>
          <li>
            <strong className="font-semibold">Transactions:</strong> the date, amount and description of each one, the bank's own type, memo and reference, and the last four digits of the card used where the bank prints it. If this Fernledger uses Akahu Sync, a Synced Transaction also holds what Akahu says about it: its category and the group above it (card Transactions only), the Account's balance after it, Akahu's content hash for it, when Akahu updated it and its posted date, and the bank connection it came from. Akahu's category is only shown, and never sets a Transaction's Category. Whatever the bank puts in those, such as another person's name or account number, is kept exactly as the bank gave it.
          </li>
          <li>
            <strong className="font-semibold">Pending Transactions:</strong> if this Fernledger uses Akahu Sync, the date, amount and description of each one the bank has reported and not settled, the bank's own type
            for it, and when the Sync that read it ran. Every Sync replaces them all, so nothing older than the last Sync is kept, and they are counted in no Budget, Report or total. Unlinking an Account clears its own.
          </li>
          <li>
            <strong className="font-semibold">Balances:</strong> the balance a bank reported for an Account on a date (in an Import's file, or, if this Fernledger uses Akahu Sync, from Akahu after a Sync, one for each day, all kept), the balance worked out from the Transactions, and the difference between them.
          </li>
          <li>
            <strong className="font-semibold">Categories:</strong> the Admin's list of them, and the Category or Note the Admin has put on a Transaction.
          </li>
          <li>
            <strong className="font-semibold">The Change Log:</strong> every change the Admin makes, with the time and the Admin's email address, and what changed, often with the values from before and after. That includes the words of any Note, so a Note the Admin changes or removes can still be read there.
          </li>
          <li>
            <strong className="font-semibold">Who may sign in:</strong> Cloudflare Access keeps the list of Members' email addresses. Fernledger doesn't keep a list of its own. It writes the Admin's email address into each Change Log entry, and into the record that lets a big change, such as applying the Rules to every Transaction, carry on in steps, and into the list of Reports the Admin has kept, as the one who last showed each. No page displays it there.
          </li>
          <li>
            <strong className="font-semibold">Settings:</strong> the app title and the text on this page.
          </li>
        </ul>
        <p>Fernledger holds no passwords, either yours or your bank's. Cloudflare Access handles signing in.</p>
        {/* Sync hasn't shipped, so "enabled" only means the access keys are set. Say just that until it does (CODING_STANDARDS, Docs). */}
        {akahu &&
          (akahu.enabled ? (
            <p>
              Akahu access keys are set up here. Akahu is a service that reads bank data with the account holder's permission. Fernledger keeps the keys safely outside the database. They can read bank data but cannot make payments.
            </p>
          ) : (
            <p>Akahu Sync isn't set up here, so Transactions come only from bank files the Admin imports.</p>
          ))}
        <p>
          A copy of the database is saved every week, as a backup. The sign-in list and any Akahu keys are kept outside the database, so the backups don't hold them. The Admin's email address is in the Change Log, in the record of a big change and in the list of kept Reports, so it is in the backups.
        </p>
      </Section>

      <Section id="seen" title="Who can see it">
        <ul className="list-disc space-y-2 ps-6">
          <li>
            <strong className="font-semibold">Members.</strong> Everyone on the Cloudflare Access sign-in list can see all of it. Members can look but not change anything.
          </li>
          <li>
            <strong className="font-semibold">The Admin.</strong> The one Member who can make changes. Every change goes in the Change Log, which every Member can see.
          </li>
          <li>
            <strong className="font-semibold">No one else.</strong> Anyone who is not on the list is stopped at Cloudflare's sign-in page.
          </li>
          <li>
            <strong className="font-semibold">Behind the scenes.</strong> Cloudflare hosts Fernledger, and whoever looks after the Cloudflare account it runs in can reach the data directly. As with any online service, Cloudflare can technically access what it hosts.
          </li>
        </ul>
        {/* ADR 0010: the promise names every outbound call, so it says so when the optional D1 usage bar is on. It waits for the Worker to say whether it is, so it is never written untrue; if the Worker cannot say, it is worded to be true either way. */}
        {!featuresPending && <p>{`Fernledger sends your data to no one else. ${contacts[usageFigures]} It has no analytics, tracking or email.`}</p>}
        <p>
          A file saved from Fernledger, such as a CSV export of Transactions, is outside all of this. See{' '}
          <a href="https://github.com/markc647/fernledger#what-it-cant-protect-against" className="underline underline-offset-4">
            what it can't protect against
          </a>
          .
        </p>
      </Section>

      <Section id="stored" title="Where it is stored">
        <p>
          In a Cloudflare account that belongs to whoever set up this Fernledger. There is no Fernledger company server, and the people who wrote Fernledger can't see your data.
        </p>
        <p>
          By default, Fernledger asks Cloudflare to keep the database and its backups in Oceania. That is a request, not a guarantee: Cloudflare doesn't say which city, and doesn't promise that data stays in New Zealand or Australia. Whoever set this up may have chosen another region.
        </p>
        <p>Your requests arrive at a nearby Cloudflare location, such as Auckland, before they reach the database. Everything is encrypted while it travels and while it is stored.</p>
      </Section>

      <Section id="kept" title="How long it is kept">
        <SettingText line={ready ? retentionLine(settings.about_retention, me.role) : undefined} failed={failed} />
        <p>Fernledger never deletes your data by itself. It stays until the Admin, or whoever runs Fernledger, chooses to remove it.</p>
        <p>
          The weekly backups are all kept. If something is removed in Fernledger, the earlier backups still hold their copy of it until whoever runs Fernledger empties the backup storage.
        </p>
      </Section>

      <Section id="ask" title="Who to ask">
        <SettingText line={ready ? contactLine(settings.about_contact, me.role) : undefined} failed={failed} />
      </Section>
    </article>
  )
}

// Who Fernledger contacts (ADR 0010), by whether the optional D1 usage bar is on. Each is a whole sentence and each is true when it is shown.
const AKAHU_ONLY_IF = 'It contacts no one but Akahu (only if this Fernledger uses Akahu Sync)'
const contacts = {
  off: `${AKAHU_ONLY_IF} and, to check a sign-in, your own Cloudflare Access.`,
  on: `${AKAHU_ONLY_IF} and your own Cloudflare account: its Access, to check a sign-in, and its usage figures, which whoever runs Fernledger has turned on to show the Admin how much of the day's free database allowance is left. Asking for those sends no Transactions, Notes or other data of yours.`,
  unknown: `${AKAHU_ONLY_IF} and your own Cloudflare account: its Access, to check a sign-in, and, if whoever runs Fernledger has turned it on, its usage figures for the Admin, to show how much of the day's free database allowance is left.`,
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  )
}

/** A Setting's line: the Admin's own words (kept as written, as plain text), or the guidance for its absence. */
function SettingText({ line, failed }: { line: SettingLine | undefined; failed: boolean }) {
  if (failed) return <p role="alert">Fernledger couldn't load this. Reload the page to try again.</p>
  if (!line) return null
  if (line.kind === 'setup') {
    return (
      <p>
        <Status tone="warning">{line.text}</Status>{' '}
        <Link
          to="/settings"
          className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Open Settings
        </Link>
      </p>
    )
  }
  return <p className="whitespace-pre-line">{line.text}</p>
}
