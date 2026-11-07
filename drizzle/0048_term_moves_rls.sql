-- Moving students between terms (Phase K): grants and tenant isolation.

-- A move is recorded once; the only later change is marking it undone.
GRANT SELECT, INSERT ON term_moves, term_move_enrolments TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (undone_at, undone_by_user_id) ON term_moves TO edubridge_app;
--> statement-breakpoint
ALTER TABLE term_moves ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE term_moves FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY term_moves_tenant ON term_moves
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE term_move_enrolments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE term_move_enrolments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY term_move_enrolments_tenant ON term_move_enrolments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Undone once, never re-done: an undone move stays as a record.
CREATE FUNCTION term_move_undo_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'this move is already undone' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER term_moves_undo_once BEFORE UPDATE ON term_moves
  FOR EACH ROW EXECUTE FUNCTION term_move_undo_once();
