-- Platform staff change the automatic invoice settings (Billing): the app role may update these columns.
GRANT UPDATE (auto_invoicing, census_days, invoice_due_days, annual_discount_bp, monthly_surcharge_bp)
  ON platform_settings TO edubridge_app;
