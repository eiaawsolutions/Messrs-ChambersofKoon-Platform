-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Kept in the database rather than the ORM so that job workers, migrations and
-- manual DBA fixes all produce a truthful timestamp. Several tables here are
-- written by more than one code path.
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
  tables text[] := array[
    'roles', 'users', 'clients', 'matters', 'enquiries', 'availability_rules',
    'appointment_proposals', 'appointments', 'document_templates', 'documents',
    'archive_files', 'message_templates', 'messages', 'procedure_stages'
  ];
begin
  foreach t in array tables loop
    if to_regclass(t) is not null then
      execute format('drop trigger if exists %I on %I', t || '_set_updated_at', t);
      execute format(
        'create trigger %I before update on %I for each row execute function set_updated_at()',
        t || '_set_updated_at', t
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Integrity constraints that express business rules the ORM cannot.
-- ---------------------------------------------------------------------------

-- An appointment must occupy positive time.
alter table appointments
  drop constraint if exists appointments_time_order_chk;
alter table appointments
  add constraint appointments_time_order_chk check (ends_at > starts_at);

alter table appointment_proposals
  drop constraint if exists appointment_proposals_time_order_chk;
alter table appointment_proposals
  add constraint appointment_proposals_time_order_chk check (ends_at > starts_at);

-- Availability windows must be well-formed and land on a real weekday.
alter table availability_rules
  drop constraint if exists availability_rules_window_chk;
alter table availability_rules
  add constraint availability_rules_window_chk
  check (end_time > start_time and weekday between 0 and 6 and slot_minutes > 0);

-- A chunk belongs to exactly one source row.
alter table chunks
  drop constraint if exists chunks_token_count_chk;
alter table chunks
  add constraint chunks_token_count_chk check (token_count >= 0);

-- Triage confidence is a percentage.
alter table enquiries
  drop constraint if exists enquiries_confidence_chk;
alter table enquiries
  add constraint enquiries_confidence_chk
  check (confidence is null or confidence between 0 and 100);

-- FR-3.4 is enforced in application code, but this constraint makes the
-- companion invariant structural: a proposal cannot be marked decided without
-- recording who decided it and when.
alter table appointment_proposals
  drop constraint if exists appointment_proposals_decided_chk;
alter table appointment_proposals
  add constraint appointment_proposals_decided_chk
  check (
    state = 'pending'
    or state = 'expired'
    or (decided_at is not null and decided_by_user_id is not null)
  );

-- No two confirmed appointments may overlap for the same lawyer (FR-3.2).
-- A partial unique-ish guarantee via exclusion constraint; needs btree_gist.
create extension if not exists btree_gist;

alter table appointments
  drop constraint if exists appointments_no_overlap_excl;
alter table appointments
  add constraint appointments_no_overlap_excl
  exclude using gist (
    user_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (state = 'confirmed');
