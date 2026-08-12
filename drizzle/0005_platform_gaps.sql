CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"query" text NOT NULL,
	"practice_area" "practice_area",
	"office" "office",
	"date_from" varchar(10),
	"date_to" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_searches_user_name_uq" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "enquiries" ADD COLUMN "duplicate_of_enquiry_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_searches_user_idx" ON "saved_searches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_reschedule_token_uq" ON "appointments" USING btree ("reschedule_token_hash");