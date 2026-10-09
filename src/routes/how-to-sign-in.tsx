import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { settingsQuery } from '@/lib/settings'

export const Route = createFileRoute('/how-to-sign-in')({
  component: HowToSignIn,
  staticData: { nav: { label: 'How to sign in', order: 86 } },
})

/**
 * The Cloudflare Access email one-time PIN sign-in (ADR 0002), in large print, for Members who find it hard. Printable:
 * the header and buttons drop out of the printout (src/routes/__root.tsx, `print:hidden`), and the text is 12pt or more.
 * The address in step 1 is the one the page is open at, so nothing about the deployment is written into the guide.
 */
function HowToSignIn() {
  const { data: settings } = useQuery(settingsQuery)
  return (
    <article className="max-w-2xl text-lg leading-relaxed print:text-[13pt] print:leading-snug">
      <h1 className="text-2xl font-semibold print:text-[20pt]">How to sign in</h1>
      <p className="mt-3">Fernledger has no password. Each time you sign in, Cloudflare emails you a short code, and you type that code in.</p>
      {settings && <p className="mt-2">This guide is for {settings.app_title}.</p>}
      <p className="mt-4 print:hidden">
        <Button size="touch" variant="outline" onClick={() => window.print()}>
          Print this guide
        </Button>
      </p>

      <ol aria-label="Steps" className="mt-6 list-decimal space-y-4 ps-9 text-xl marker:font-semibold print:mt-4 print:space-y-2 print:text-[14pt]">
        {/* Each step stays whole across a page break. */}
        <li className="break-inside-avoid ps-1">
          <strong className="font-semibold">Open Fernledger.</strong> Use the link the Admin gave you, or the Fernledger icon on your Home Screen. Fernledger's address is{' '}
          <strong className="font-semibold">{window.location.host}</strong>.
        </li>
        <li className="break-inside-avoid ps-1">
          <strong className="font-semibold">Type your email address.</strong> A page from Cloudflare asks for it. Use the email address the Admin has for you, then press the button that sends you a code. It says "Send login code".
        </li>
        <li className="break-inside-avoid ps-1">
          <strong className="font-semibold">Wait for the email.</strong> It comes from Cloudflare Access and has a code in it. It usually arrives within a minute or two. If you can't see it, look in your junk or spam folder.
        </li>
        <li className="break-inside-avoid ps-1">
          <strong className="font-semibold">Type the code in.</strong> Type the code from the email into the Cloudflare page and press "Sign in". The code works for 10 minutes. If it has run out, ask for a new one.
        </li>
        <li className="break-inside-avoid ps-1">
          <strong className="font-semibold">You're in.</strong> Fernledger opens. You stay signed in on this device for 24 hours. After that, do these steps again.
        </li>
      </ol>

      <h2 className="mt-8 text-xl font-semibold print:mt-4 print:text-[15pt]">If something goes wrong</h2>
      <ul className="mt-2 list-disc space-y-2 ps-9 print:space-y-1">
        <li className="break-inside-avoid">
          <strong className="font-semibold">No email came.</strong> Check your junk or spam folder. Check that you typed the address exactly as the Admin has it. If it isn't on the Admin's list, Cloudflare sends nothing and doesn't tell you.
        </li>
        <li className="break-inside-avoid">
          <strong className="font-semibold">The code didn't work.</strong> Ask for a new code, and use the one in the newest email.
        </li>
        <li className="break-inside-avoid">
          <strong className="font-semibold">Still stuck?</strong> Ask the Admin.
        </li>
      </ul>
      <p className="mt-4 print:mt-3">Keep your code to yourself, and only sign in on a phone, tablet or computer you trust.</p>
    </article>
  )
}
