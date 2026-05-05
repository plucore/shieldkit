# ShieldKit v2 — Customer outreach emails

Three emails to send when v2 ships:

1. **Email 1A** — to the 2 v1 paying customers (NORMAE, Glamourous Grace).
   Thank-you + v2 update + 50% off first 3 months coupon.
2. **Email 1B** — to the 14 free-tier merchants currently installed.
   Heads-up that free now resets monthly + intro to the new paid plans.
3. **Email 2** — review request, sent **5+ days after Email 1**.
   Decoupled so the favour-ask doesn't ride along with a transactional update.

Fill the `[name]` and `[coupon]` placeholders before sending. The 50% coupon
needs to be created in the Shopify Partners → ShieldKit app → Pricing
section (Shopify supports issuing per-merchant discount codes for App
Subscriptions).

---

## Email 1A — to NORMAE and Glamourous Grace (paid v1 customers)

> **Subject:** Thanks for trying ShieldKit early — v2 is here, and there's a 50% off code inside

> Hey [name],
>
> A quick personal note. You bought ShieldKit when it was a $29 one-time
> purchase, way before there was much of an app to speak of. That early bet
> meant a lot — it bought me the runway to actually build the product I was
> describing, and I wanted to thank you for it before anything else.
>
> A few things have changed since you installed:
>
> **The product is meaningfully different now.** ShieldKit went from a
> single 10-point GMC compliance scan into something closer to a full
> trust-and-visibility layer. There are now 12 checks (we added a hidden-fee
> detector and a dropshipper-image audit, both of which Google's been
> aggressive about in the last six months). Continuous weekly monitoring
> runs on a cron. There's a GMC re-review appeal letter generator powered
> by Claude. And on the AI-search side, we've added Organization & WebSite
> JSON-LD schema, an llms.txt feed at your shop's app proxy URL, an AI bot
> allow/block toggle, and a GTIN/MPN/brand auto-filler that's pending
> Shopify scope approval (it lights up the moment that comes through).
>
> **Pricing is now recurring instead of one-time.** The two new tiers are:
>
> - **Shield Pro** — $14/month or $140/year. Continuous monitoring, weekly
>   health digest email, GMC appeal letter, hidden fee detector, image
>   hosting audit, AI policy generator.
> - **Shield Max** — $39/month or $390/year. Everything above, plus the
>   Merchant Listings JSON-LD enricher, GTIN auto-filler, llms.txt at root
>   via app proxy, Organization & WebSite schema blocks, AI bot toggle, and
>   the dedicated Shield Max settings page.
>
> **Your existing $29 one-time purchase covered the v1 product.** It's a
> different product now, and recurring infrastructure is a different cost
> shape, so v2 features sit behind the new subscription. I wanted to make
> the transition cheap if you decide to jump in:
>
> Use code **`[coupon]`** at checkout and get **50% off your first 3
> months** of either Shield Pro or Shield Max. The code's good through
> [date]. The new plans live behind the in-app upgrade button — open
> ShieldKit, click Manage plan in the sidebar.
>
> Either way, you'll keep the v1 features you already have on the free
> tier (the JSON-LD theme block + a fresh monthly scan).
>
> If you have a question, feedback, or just want me to walk you through
> the new stuff — reply to this email and I'll either get back to you or
> book a call.
>
> Thanks again for being one of the first.
>
> [your name]

---

## Email 1B — to the 14 free-tier merchants

> **Subject:** ShieldKit just got a meaningful update — fresh scan every month + new paid tiers

> Hey there,
>
> Quick update on ShieldKit since you installed.
>
> **Your free tier reset to monthly.** You had one scan total before. Now
> you get a fresh scan every 30 days automatically — open the app any time
> after the 1st of each month and you can re-scan to check progress.
>
> **The scanner got more thorough.** We're up to 12 checks. The two new
> ones are a hidden-fee detector (Google's been aggressive about
> undisclosed surcharges since July) and a dropshipper-image audit that
> flags products serving images off supplier CDNs like AliExpress or
> CJDropshipping — Google reads that as a misrepresentation signal.
> Both run on the free tier.
>
> **There are two new paid plans for merchants who want continuous
> coverage.** Free is fine if you only want spot-checks. The paid tiers
> light up if you want the app working in the background:
>
> - **Shield Pro — $14/month** — unlimited scans, continuous weekly
>   monitoring, weekly health digest email summarising new issues caught
>   and fixes confirmed, AI policy generator, GMC re-review appeal letter
>   generator.
> - **Shield Max — $39/month** — everything in Shield Pro, plus the
>   AI-search visibility tools: Merchant Listings JSON-LD enricher
>   (so your products show up correctly in Google AI Overviews and
>   ChatGPT shopping results), an llms.txt feed at your shop's app
>   proxy URL, an AI bot allow/block toggle, and a GTIN auto-filler.
>
> Annual billing saves you 16% on either plan.
>
> Open ShieldKit, click "Manage plan" in the sidebar, and you'll see both
> options laid out side-by-side. Toggle Monthly / Annual at the top —
> whichever cycle you pick on the toggle is what the "Choose" button signs
> you up for.
>
> If you've never run a scan yet, the free monthly scan works just like
> before — open the app, hit "Run My Free Compliance Scan", and the 12
> checks run against your store.
>
> Questions, feedback, or want me to walk through anything? Reply to this
> email.
>
> [your name]
> ShieldKit

---

## Email 2 — review request (sent 5+ days after Email 1)

Send this **after** Email 1A or 1B, never together. The favour-ask
decoupling is deliberate: bundling a request for a public review with a
transactional update muddies both messages and tends to drop response
rates on the review.

Send to whichever group has been around long enough that the request is
plausible:

- The 2 v1 paying customers — they've used ShieldKit for months and
  have something concrete to write about.
- Any free-tier merchant who has run at least one scan and clicked into
  a fix instruction (use the `scans.created_at` + `violations.fix_instruction`
  signal to filter — anyone with a recent scan and at least one
  failed check qualifies).

Skip free-tier merchants who installed but never scanned — they have
nothing to review.

> **Subject:** A favour, if ShieldKit's been useful

> Hey [name],
>
> If ShieldKit's been useful — even a little — would you write me a
> short honest review on the Shopify App Store?
>
> Here's the link: [apps.shopify.com/shieldkit/reviews](https://apps.shopify.com/shieldkit/reviews)
>
> A few sentences is plenty. What worked, what was confusing, what
> you'd want next. Honest is more useful than glowing — I read every
> one.
>
> Reviews are how new merchants find ShieldKit on the App Store and
> they help me a lot at this stage of the business.
>
> No pressure either way. If now's not the right time, ignore this and
> we're cool.
>
> Thanks,
>
> [your name]

---

## Sending sequence (operational notes)

1. **Day 0** — Send Email 1A to NORMAE and Glamourous Grace. Wait for
   the coupon to be live in Shopify Partners before sending.
2. **Day 0** — Send Email 1B to the 14 free-tier merchants. Pull the
   list with:
   ```sql
   SELECT shopify_domain, shop_name, l.email
     FROM merchants m
     LEFT JOIN leads l ON l.shop_domain = m.shopify_domain
    WHERE m.tier = 'free'
      AND m.uninstalled_at IS NULL;
   ```
   Skip rows where `l.email` is NULL — that merchant never ran a scan,
   so we don't have an address.
3. **Day 5+** — Send Email 2 to the same recipients. Two cohorts:
   - Paid customers from Email 1A — always.
   - Free merchants from Email 1B who have at least one scan with
     ≥ 1 failed check. Pull with:
     ```sql
     SELECT DISTINCT m.shopify_domain, l.email
       FROM merchants m
       JOIN leads l ON l.shop_domain = m.shopify_domain
       JOIN scans s ON s.merchant_id = m.id
       JOIN violations v ON v.scan_id = s.id
      WHERE m.tier = 'free'
        AND m.uninstalled_at IS NULL
        AND v.passed = false
        AND s.created_at > now() - interval '90 days';
     ```
4. Track sends in your own log (or use Resend's send history) so
   nobody gets either email twice.

---

## Sender + reply-to recommendations

- **From:** `[your name] <hello@shieldkit.app>`
- **Reply-to:** your personal address (e.g. `[your name]@plucore.com`).
  Replies are the highest-signal feedback on these emails — make them
  easy.
- **Sending platform:** Resend works for the digest cron and for these
  one-off outreach emails. For more deliverability headroom on a one-time
  blast, your own inbox or a dedicated tool (Customer.io, Loops) is
  fine — Resend is overkill for 16 sends.
