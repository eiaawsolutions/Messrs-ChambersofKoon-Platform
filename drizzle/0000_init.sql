CREATE TYPE "public"."appointment_state" AS ENUM('confirmed', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."chunk_source_type" AS ENUM('archive_file', 'document_version');--> statement-breakpoint
CREATE TYPE "public"."document_state" AS ENUM('draft', 'in_review', 'final');--> statement-breakpoint
CREATE TYPE "public"."enquiry_source" AS ENUM('widget', 'form', 'manual');--> statement-breakpoint
CREATE TYPE "public"."enquiry_status" AS ENUM('new', 'triaged', 'needs_review', 'slot_proposed', 'booked', 'declined', 'spam');--> statement-breakpoint
CREATE TYPE "public"."generated_by" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."matter_status" AS ENUM('open', 'on_hold', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_state" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."ocr_state" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."office" AS ENUM('KL', 'PJ', 'IPOH');--> statement-breakpoint
CREATE TYPE "public"."practice_area" AS ENUM('family_matrimonial', 'debt_recovery', 'land_property', 'corporate_disputes', 'general');--> statement-breakpoint
CREATE TYPE "public"."proposal_state" AS ENUM('pending', 'accepted', 'rescheduled', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" varchar(60) NOT NULL,
	"model_version" varchar(80) NOT NULL,
	"prompt_hash" varchar(64),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" varchar(20) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"actor_user_id" uuid,
	"matter_id" uuid,
	"succeeded" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"proposed_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"state" "proposal_state" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decline_reason" text,
	"supersedes_proposal_id" uuid,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid,
	"enquiry_id" uuid,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location" varchar(300) NOT NULL,
	"title" varchar(300) NOT NULL,
	"client_email" varchar(320),
	"client_name" varchar(200),
	"ics_uid" varchar(200) NOT NULL,
	"ics_sequence" integer DEFAULT 0 NOT NULL,
	"state" "appointment_state" DEFAULT 'confirmed' NOT NULL,
	"reschedule_token_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_ics_uid_unique" UNIQUE("ics_uid")
);
--> statement-breakpoint
CREATE TABLE "archive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid,
	"practice_area" "practice_area",
	"original_filename" varchar(400) NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"page_count" integer,
	"content_hash" varchar(64) NOT NULL,
	"ocr_state" "ocr_state" DEFAULT 'pending' NOT NULL,
	"ocr_error" text,
	"ocr_attempts" integer DEFAULT 0 NOT NULL,
	"extracted_text" text,
	"uploaded_by_user_id" uuid,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" varchar(320),
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(60),
	"entity_id" uuid,
	"matter_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"office" "office" NOT NULL,
	"practice_area" "practice_area",
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"slot_minutes" integer DEFAULT 45 NOT NULL,
	"buffer_minutes" integer DEFAULT 15 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "chunk_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"matter_id" uuid,
	"practice_area" "practice_area",
	"office" "office",
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"locator" varchar(120),
	"embedding_model_version" varchar(80) NOT NULL,
	"document_date" timestamp with time zone,
	"outcome" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_source_index_uq" UNIQUE("source_type","source_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"email" varchar(320),
	"phone" varchar(40),
	"id_number_encrypted" text,
	"notes" text,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"practice_area" "practice_area" NOT NULL,
	"doc_type" varchar(80) NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"placeholder_schema" jsonb DEFAULT '{"deterministic":[],"ai":[]}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_name_version_uq" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"generated_by" "generated_by" NOT NULL,
	"model_version" varchar(80),
	"prompt_hash" varchar(64),
	"generation_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cited_chunk_ids" uuid[],
	"ai_blocks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_summary" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" varchar(20),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_doc_no_uq" UNIQUE("document_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid NOT NULL,
	"template_id" uuid,
	"title" varchar(300) NOT NULL,
	"state" "document_state" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"finalised_at" timestamp with time zone,
	"finalised_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_edit_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"block_name" varchar(120) NOT NULL,
	"ai_text" text NOT NULL,
	"edited_text" text NOT NULL,
	"edited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "enquiry_source" DEFAULT 'widget' NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_name" varchar(200),
	"contact_email" varchar(320),
	"contact_phone" varchar(40),
	"practice_area_predicted" "practice_area",
	"office" "office",
	"urgency" "urgency" DEFAULT 'normal' NOT NULL,
	"confidence" integer,
	"case_brief_md" text,
	"status" "enquiry_status" DEFAULT 'new' NOT NULL,
	"matter_id" uuid,
	"session_token" varchar(64),
	"submitted_ip" varchar(64),
	"model_version" varchar(80),
	"prompt_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enquiry_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exception_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid,
	"message_id" uuid,
	"kind" varchar(60) NOT NULL,
	"title" varchar(300) NOT NULL,
	"detail" text,
	"assigned_user_id" uuid,
	"state" "task_state" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(80) NOT NULL,
	"role_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_role_uq" UNIQUE("key","role_id")
);
--> statement-breakpoint
CREATE TABLE "matter_participants" (
	"matter_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(60) DEFAULT 'contributor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "matter_participants_matter_id_user_id_pk" PRIMARY KEY("matter_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "matter_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid NOT NULL,
	"stage" varchar(80) NOT NULL,
	"recorded_by_user_id" uuid,
	"notes" text,
	"suppressed" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(60) NOT NULL,
	"client_id" uuid NOT NULL,
	"practice_area" "practice_area" NOT NULL,
	"office" "office" NOT NULL,
	"title" varchar(300) NOT NULL,
	"assigned_user_id" uuid,
	"supervising_user_id" uuid,
	"status" "matter_status" DEFAULT 'open' NOT NULL,
	"comms_hold" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matters_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "message_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid NOT NULL,
	"stage" varchar(80),
	"reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_suppressions_matter_stage_uq" UNIQUE("matter_id","stage")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"subject" varchar(300) NOT NULL,
	"body_md" text NOT NULL,
	"locale" varchar(12) DEFAULT 'en-MY' NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matter_id" uuid,
	"enquiry_id" uuid,
	"to_email" varchar(320) NOT NULL,
	"template_key" varchar(120),
	"subject" varchar(300) NOT NULL,
	"body_rendered" text NOT NULL,
	"resend_message_id" varchar(120),
	"state" "message_state" DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"error" text,
	"idempotency_key" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(60) DEFAULT 'General' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "procedure_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_area" "practice_area" NOT NULL,
	"key" varchar(80) NOT NULL,
	"label" varchar(160) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"message_template_key" varchar(120),
	"sla_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procedure_stages_area_key_uq" UNIQUE("practice_area","key")
);
--> statement-breakpoint
CREATE TABLE "public_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" varchar(10) NOT NULL,
	"name" varchar(160) NOT NULL,
	"office" "office",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_holidays_date_office_uq" UNIQUE("date","office")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" varchar(200) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"scope" varchar(16) DEFAULT 'own' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint_hash" varchar(64) NOT NULL,
	"label" varchar(160),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_user_fp_uq" UNIQUE("user_id","fingerprint_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"role_id" uuid NOT NULL,
	"office" "office" DEFAULT 'KL' NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"practice_areas" "practice_area"[],
	"sso_provider" varchar(40),
	"sso_subject" varchar(255),
	"last_login_at" timestamp with time zone,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_proposals" ADD CONSTRAINT "appointment_proposals_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_proposals" ADD CONSTRAINT "appointment_proposals_proposed_user_id_users_id_fk" FOREIGN KEY ("proposed_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_proposals" ADD CONSTRAINT "appointment_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_files" ADD CONSTRAINT "archive_files_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_files" ADD CONSTRAINT "archive_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_finalised_by_user_id_users_id_fk" FOREIGN KEY ("finalised_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_edit_signals" ADD CONSTRAINT "draft_edit_signals_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_edit_signals" ADD CONSTRAINT "draft_edit_signals_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiry_messages" ADD CONSTRAINT "enquiry_messages_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_tasks" ADD CONSTRAINT "exception_tasks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_tasks" ADD CONSTRAINT "exception_tasks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_tasks" ADD CONSTRAINT "exception_tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_tasks" ADD CONSTRAINT "exception_tasks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_participants" ADD CONSTRAINT "matter_participants_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_participants" ADD CONSTRAINT "matter_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_participants" ADD CONSTRAINT "matter_participants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_status_events" ADD CONSTRAINT "matter_status_events_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_status_events" ADD CONSTRAINT "matter_status_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_supervising_user_id_users_id_fk" FOREIGN KEY ("supervising_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_suppressions" ADD CONSTRAINT "message_suppressions_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_suppressions" ADD CONSTRAINT "message_suppressions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_task_idx" ON "ai_usage_events" USING btree ("task");--> statement-breakpoint
CREATE INDEX "appointment_proposals_state_idx" ON "appointment_proposals" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "appointment_proposals_user_idx" ON "appointment_proposals" USING btree ("proposed_user_id","state");--> statement-breakpoint
CREATE INDEX "appointment_proposals_enquiry_idx" ON "appointment_proposals" USING btree ("enquiry_id");--> statement-breakpoint
CREATE INDEX "appointments_user_time_idx" ON "appointments" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_matter_idx" ON "appointments" USING btree ("matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_files_content_hash_uq" ON "archive_files" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "archive_files_state_idx" ON "archive_files" USING btree ("ocr_state");--> statement-breakpoint
CREATE INDEX "archive_files_matter_idx" ON "archive_files" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "archive_files_batch_idx" ON "archive_files" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_matter_idx" ON "audit_events" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "availability_rules_user_idx" ON "availability_rules" USING btree ("user_id","weekday");--> statement-breakpoint
CREATE INDEX "chunks_source_idx" ON "chunks" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "chunks_matter_idx" ON "chunks" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "chunks_area_idx" ON "chunks" USING btree ("practice_area");--> statement-breakpoint
CREATE INDEX "clients_email_idx" ON "clients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "document_templates_area_idx" ON "document_templates" USING btree ("practice_area","is_active");--> statement-breakpoint
CREATE INDEX "documents_matter_idx" ON "documents" USING btree ("matter_id","created_at");--> statement-breakpoint
CREATE INDEX "enquiries_status_idx" ON "enquiries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "enquiries_session_idx" ON "enquiries" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "enquiries_email_idx" ON "enquiries" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "enquiry_messages_enquiry_idx" ON "enquiry_messages" USING btree ("enquiry_id","created_at");--> statement-breakpoint
CREATE INDEX "exception_tasks_state_idx" ON "exception_tasks" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "matter_status_events_matter_idx" ON "matter_status_events" USING btree ("matter_id","occurred_at");--> statement-breakpoint
CREATE INDEX "matters_assigned_idx" ON "matters" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "matters_supervising_idx" ON "matters" USING btree ("supervising_user_id");--> statement-breakpoint
CREATE INDEX "matters_office_area_idx" ON "matters" USING btree ("office","practice_area");--> statement-breakpoint
CREATE INDEX "matters_client_idx" ON "matters" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "messages_matter_idx" ON "messages" USING btree ("matter_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_state_idx" ON "messages" USING btree ("state");--> statement-breakpoint
CREATE INDEX "messages_resend_idx" ON "messages" USING btree ("resend_message_id");--> statement-breakpoint
CREATE INDEX "rate_limit_window_idx" ON "rate_limit_buckets" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "users_office_idx" ON "users" USING btree ("office");