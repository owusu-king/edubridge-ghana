-- Inventory, assets and procurement (R4-6, module inventory_assets): tenant isolation, and history that cannot be
-- rewritten. Stock movements, asset events and maintenance updates are insert-only; suppliers, stock items and
-- assets are archived or disposed, never deleted; purchase and maintenance requests move only forward.

GRANT SELECT, INSERT, UPDATE ON inventory_suppliers TO edubridge_app;
--> statement-breakpoint
ALTER TABLE inventory_suppliers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inventory_suppliers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_suppliers_tenant ON inventory_suppliers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE inventory_suppliers ADD CONSTRAINT inventory_suppliers_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON stock_items TO edubridge_app;
--> statement-breakpoint
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stock_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stock_items_tenant ON stock_items
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE stock_items ADD CONSTRAINT stock_items_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT ON stock_movements TO edubridge_app;
--> statement-breakpoint
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stock_movements_tenant ON stock_movements
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_values
  CHECK (kind in ('received', 'issued', 'counted'));
--> statement-breakpoint
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_purchase_request_fk
  FOREIGN KEY (tenant_id, purchase_request_id) REFERENCES purchase_requests (tenant_id, id);
--> statement-breakpoint
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON assets TO edubridge_app;
--> statement-breakpoint
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assets_tenant ON assets
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE assets ADD CONSTRAINT assets_values
  CHECK (status in ('active', 'disposed') AND condition in ('new', 'good', 'fair', 'poor', 'broken'));
--> statement-breakpoint
CREATE FUNCTION asset_disposed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'disposed' OR NEW.tag <> OLD.tag THEN
    RAISE EXCEPTION 'an asset keeps its tag, is never deleted, and does not change once disposed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assets_disposed_final BEFORE UPDATE OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION asset_disposed_final();
--> statement-breakpoint

GRANT SELECT, INSERT ON asset_events TO edubridge_app;
--> statement-breakpoint
ALTER TABLE asset_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE asset_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY asset_events_tenant ON asset_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE asset_events ADD CONSTRAINT asset_events_kind_values
  CHECK (kind in ('added', 'moved', 'custodian', 'condition', 'disposed'));
--> statement-breakpoint
CREATE TRIGGER asset_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON asset_events
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

GRANT SELECT, INSERT ON purchase_requests TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, closed_by_user_id, closed_at, closing_note,
  updated_at) ON purchase_requests TO edubridge_app;
--> statement-breakpoint
ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE purchase_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY purchase_requests_tenant ON purchase_requests
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_status_values
  CHECK (status in ('pending', 'approved', 'declined', 'cancelled', 'received'));
--> statement-breakpoint
-- Forward only: waiting → approved, declined or cancelled; approved → received or cancelled. A decision is made
-- once and kept.
CREATE FUNCTION purchase_request_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NOT (
      (OLD.status = 'pending' AND NEW.status IN ('approved', 'declined', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status IN ('received', 'cancelled'))
    )
    OR (OLD.decided_at IS NOT NULL AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
      OR NEW.decision_note IS DISTINCT FROM OLD.decision_note))
  THEN
    RAISE EXCEPTION 'a purchase request only moves forward and is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_requests_forward_only BEFORE UPDATE OR DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION purchase_request_forward_only();
--> statement-breakpoint

GRANT SELECT, INSERT ON purchase_request_lines TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (received_quantity) ON purchase_request_lines TO edubridge_app;
--> statement-breakpoint
ALTER TABLE purchase_request_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE purchase_request_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY purchase_request_lines_tenant ON purchase_request_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION purchase_line_received_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.received_quantity IS NOT NULL OR NEW.received_quantity IS NULL THEN
    RAISE EXCEPTION 'what arrived is recorded once, and lines are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_request_lines_received_once BEFORE UPDATE OR DELETE ON purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_line_received_once();
--> statement-breakpoint

GRANT SELECT, INSERT ON maintenance_requests TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, assigned_to, updated_at) ON maintenance_requests TO edubridge_app;
--> statement-breakpoint
ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE maintenance_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY maintenance_requests_tenant ON maintenance_requests
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD CONSTRAINT maintenance_requests_values
  CHECK (status in ('open', 'in_progress', 'done', 'cancelled') AND priority in ('low', 'normal', 'urgent'));
--> statement-breakpoint
CREATE FUNCTION maintenance_request_closed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('done', 'cancelled')
    OR (OLD.status = 'in_progress' AND NEW.status = 'open') THEN
    RAISE EXCEPTION 'a done or cancelled maintenance request does not change, and none is deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER maintenance_requests_closed_final BEFORE UPDATE OR DELETE ON maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION maintenance_request_closed_final();
--> statement-breakpoint

GRANT SELECT, INSERT ON maintenance_updates TO edubridge_app;
--> statement-breakpoint
ALTER TABLE maintenance_updates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE maintenance_updates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY maintenance_updates_tenant ON maintenance_updates
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER maintenance_updates_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON maintenance_updates
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
