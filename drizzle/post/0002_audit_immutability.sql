-- ---------------------------------------------------------------------------
-- Append-only audit log (PRD §4.1, FR-1.7, G5)
--
-- "Append-only: no UPDATE or DELETE grants for the application role; enforce
--  with a trigger that raises on update/delete."
--
-- The trigger is the load-bearing control. Grants are also revoked below where
-- the application role is distinct from the owner, but on Railway the app
-- frequently connects as the database owner — and an owner bypasses table
-- privileges. A trigger does not care who you are.
-- ---------------------------------------------------------------------------

create or replace function audit_events_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'audit_events is append-only (attempted % on row %)',
    tg_op,
    coalesce(old.id::text, '<unknown>')
    using errcode = 'restrict_violation',
          hint = 'Audit history is immutable under professional-conduct review. '
                 'Correct the record by appending a compensating event.';
end;
$$;

drop trigger if exists audit_events_no_update on audit_events;
create trigger audit_events_no_update
  before update on audit_events
  for each row execute function audit_events_reject_mutation();

drop trigger if exists audit_events_no_delete on audit_events;
create trigger audit_events_no_delete
  before delete on audit_events
  for each row execute function audit_events_reject_mutation();

-- Truncate bypasses row triggers entirely, so it needs its own statement-level
-- guard — otherwise a single TRUNCATE erases the whole defensibility story.
create or replace function audit_events_reject_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events cannot be truncated'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_events_no_truncate on audit_events;
create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function audit_events_reject_truncate();
