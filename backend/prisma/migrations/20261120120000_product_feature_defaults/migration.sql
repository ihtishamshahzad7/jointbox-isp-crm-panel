-- The platform product switches had no rows, so both products were OFF on
-- every install until someone found the switch on Plans & Pricing — and the
-- per-company tick boxes silently did nothing. Turn the platform switch ON by
-- default: each company still needs the product ticked on its own plan, so
-- nothing is given to any company by this. An operator who has already turned
-- a switch off keeps that choice (DO NOTHING on an existing row).
INSERT INTO "product_feature" ("key", "enabled", "updatedAt")
VALUES ('ai-assistant', true, CURRENT_TIMESTAMP),
       ('crm-advanced', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
