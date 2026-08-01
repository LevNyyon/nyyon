-- Split "somebody claimed this install" from "setup is finished".
--
-- WHY
-- 0067 fused two different facts into one column. `onboarded_at` was stamped
-- by setAdminCredentials, which ALSO burned the setup token, in one write at
-- the very end of a fifteen-minute voice interview. That ordering is what kept
-- a new operator outside their own product until the interview was over: the
-- account did not exist until the last question was answered.
--
-- The new order creates the account FIRST (username + password, a form, no
-- model involved), then asks for a model key, then runs the interview. That
-- only works if the two facts are separate, because the first one now happens
-- while the other two steps still have to be reachable:
--
--   HAS_ADMIN       — admin_user + admin_hash exist, and admin_set_at says
--                     when. From this moment the operator can sign in, and the
--                     session cookie becomes the ONLY proof of setup access
--                     (the setup token is burned in the same write, and the
--                     loopback exemption stops applying).
--   SETUP_COMPLETE  — setup_completed_at. The voice interview produced its
--                     documents. This is the flag that closes verifySetupAccess
--                     permanently, so the setup surface can never be reopened.
--
-- And one soft state between them:
--
--   SETUP_DEFERRED  — setup_deferred_at. The operator said "later" and went
--                     into the app. NOT the same as complete: completion is
--                     irreversible by design, and an operator who is allowed
--                     to resume needs the surface to still be alive. Cleared
--                     when they come back to it, and it is what raises the
--                     "your voice documents are still the shipped defaults"
--                     banner.
--
-- `onboarded_at` is kept, still meaning "setup is finished", and is written in
-- the same statement as setup_completed_at so a build that reads either column
-- sees the same truth. Nothing reads it as "has an account" any more.
ALTER TABLE install_state ADD COLUMN admin_set_at       INTEGER;
ALTER TABLE install_state ADD COLUMN setup_completed_at INTEGER;
ALTER TABLE install_state ADD COLUMN setup_deferred_at  INTEGER;

-- An install that finished the OLD flow did both things at the same instant,
-- so both new stamps take the old one. Without this backfill an already-live
-- install would look like "account exists, setup never finished" and would be
-- shown the interview again on the next load.
UPDATE install_state
   SET admin_set_at       = COALESCE(admin_set_at, onboarded_at),
       setup_completed_at = COALESCE(setup_completed_at, onboarded_at)
 WHERE onboarded_at IS NOT NULL;
