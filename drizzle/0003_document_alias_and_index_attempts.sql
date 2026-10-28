ALTER TABLE "documents" ADD COLUMN "indexAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "aliasOf" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_aliasOf_documents_id_fk" FOREIGN KEY ("aliasOf") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_user_content_hash_idx" ON "documents" USING btree ("userId","contentHash");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "documents_release_aliases"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "documents"
  SET "aliasOf" = NULL,
      "indexedAt" = NULL,
      "indexAttempts" = 0
  WHERE "aliasOf" = OLD."id";
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_release_aliases" ON "documents";--> statement-breakpoint
CREATE TRIGGER "documents_release_aliases"
BEFORE DELETE ON "documents"
FOR EACH ROW
EXECUTE FUNCTION "documents_release_aliases"();