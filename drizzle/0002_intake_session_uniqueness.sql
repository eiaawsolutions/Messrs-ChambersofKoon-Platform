-- Intake session tokens become unique.
--
-- Before this, a widget session token was a plain indexed column and the
-- browser held it in localStorage indefinitely, so unrelated enquiries could
-- resolve to one conversation. Existing rows are cleaned before the index is
-- created, because the data this fixes is exactly the data that would make
-- the constraint fail.

-- 1. A token still attached to an enquiry that has been handed to a lawyer,
--    or that is idle past the two-hour session window, can no longer resume
--    anything. Retire it so no browser still holding it can append.
UPDATE "enquiries" SET "session_token" = NULL
WHERE "session_token" IS NOT NULL
  AND (
    "status" <> 'new'
    OR COALESCE(
         (SELECT max(m."created_at") FROM "enquiry_messages" m WHERE m."enquiry_id" = "enquiries"."id"),
         "enquiries"."created_at"
       ) < now() - interval '120 minutes'
  );
--> statement-breakpoint

-- 2. Any remaining duplicate keeps the newest enquiry only. An older row
--    sharing a token is a conversation the enquirer has already moved on from.
UPDATE "enquiries" SET "session_token" = NULL
WHERE "session_token" IS NOT NULL
  AND "id" <> (
    SELECT e2."id" FROM "enquiries" e2
    WHERE e2."session_token" = "enquiries"."session_token"
    ORDER BY e2."created_at" DESC, e2."id" DESC
    LIMIT 1
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "enquiries_session_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "enquiries_session_idx" ON "enquiries" USING btree ("session_token");
