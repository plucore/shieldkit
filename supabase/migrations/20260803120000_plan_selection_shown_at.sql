-- 20260803120000_plan_selection_shown_at.sql
--
-- One-time "we showed this merchant the plan picker" marker.
--
-- WHY THIS EXISTS. Shopify App Pricing does NOT show the plan selection page
-- by itself — the docs are explicit that redirecting to it is the app's job
-- ("When merchants install your app or need to select a plan, redirect them to
-- this page"). ShieldKit never did, so every install was auto-enrolled on the
-- Free plan and the paid plan was reachable only by clicking an in-app Upgrade
-- button. The Partner event log for 2026-07/2026-08 is a solid wall of
-- "Free - Free subscription" activations: nobody was declining Monitoring,
-- nobody was ever shown it.
--
-- WHY A COLUMN AND NOT A LIVE SUBSCRIPTION CHECK. The documented pattern gates
-- the redirect on "has no active payment", which for an app with a genuine free
-- tier would bounce every free merchant to the picker on EVERY page load and
-- make the free tier unusable. ShieldKit's free tier is a real product (one
-- scan), so the picker must be shown ONCE and then never again. That needs
-- persisted state, and this column is it.
--
-- THE BACKFILL IS DELIBERATE AND IS THE CONSERVATIVE CHOICE. Stamping every
-- existing row scopes the redirect to NEW installs only, so the 57 merchants
-- already living in the app are not bounced out of it mid-session by a deploy.
-- To opt the existing free base in later — a real growth lever, since none of
-- them has ever seen the paid plan — clear the marker for them:
--
--   UPDATE merchants SET plan_selection_shown_at = NULL
--    WHERE tier = 'free' AND uninstalled_at IS NULL;
--
-- NULL  = never shown the picker  -> redirect once, then stamp
-- stamp = already shown (or backfilled) -> never redirect again

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS plan_selection_shown_at TIMESTAMPTZ;

COMMENT ON COLUMN merchants.plan_selection_shown_at IS
  'When the merchant was redirected to the Shopify App Pricing plan selection page. NULL = never shown; the app.tsx layout loader redirects once and stamps this. Backfilled to now() on 2026-08-03 so the redirect applies to new installs only.';

-- Scope to new installs. See the note above for opting the existing base in.
UPDATE merchants
   SET plan_selection_shown_at = now()
 WHERE plan_selection_shown_at IS NULL;
