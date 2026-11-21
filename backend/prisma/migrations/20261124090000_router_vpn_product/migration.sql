-- Router VPN is a product the platform allows per company (Plans & Pricing),
-- like AI Assistant and Advanced CRM. Platform switch ON; each company still
-- needs it ticked on its plan, so no company gets it from this alone.
INSERT INTO "product_feature" ("key", "enabled", "updatedAt")
VALUES ('router-vpn', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
