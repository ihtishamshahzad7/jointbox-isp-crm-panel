-- CreateIndex
CREATE INDEX "ActivityLog_userId_idx" ON "ActivityLog"("userId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_entity_entityId_idx" ON "ActivityLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "Invoice_subscriberId_idx" ON "Invoice"("subscriberId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "IpPool_nasId_idx" ON "IpPool"("nasId");

-- CreateIndex
CREATE INDEX "LoginLog_userId_idx" ON "LoginLog"("userId");

-- CreateIndex
CREATE INDEX "LoginLog_createdAt_idx" ON "LoginLog"("createdAt");

-- CreateIndex
CREATE INDEX "LoginLog_email_idx" ON "LoginLog"("email");

-- CreateIndex
CREATE INDEX "NetworkLog_nasId_idx" ON "NetworkLog"("nasId");

-- CreateIndex
CREATE INDEX "NetworkLog_subscriberId_idx" ON "NetworkLog"("subscriberId");

-- CreateIndex
CREATE INDEX "NetworkLog_loggedAt_idx" ON "NetworkLog"("loggedAt");

-- CreateIndex
CREATE INDEX "NetworkLog_eventType_idx" ON "NetworkLog"("eventType");

-- CreateIndex
CREATE INDEX "NetworkLog_username_idx" ON "NetworkLog"("username");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_subscriberId_idx" ON "Payment"("subscriberId");

-- CreateIndex
CREATE INDEX "Payment_receivedBy_idx" ON "Payment"("receivedBy");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Payment_method_idx" ON "Payment"("method");

-- CreateIndex
CREATE INDEX "PppoeSession_nasId_idx" ON "PppoeSession"("nasId");

-- CreateIndex
CREATE INDEX "PppoeSession_subscriberId_idx" ON "PppoeSession"("subscriberId");

-- CreateIndex
CREATE INDEX "PppoeSession_username_idx" ON "PppoeSession"("username");

-- CreateIndex
CREATE INDEX "PppoeSession_isActive_lastSeenAt_idx" ON "PppoeSession"("isActive", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ServiceSettings_expiryDate_idx" ON "ServiceSettings"("expiryDate");

-- CreateIndex
CREATE INDEX "ServiceSettings_isBlocked_idx" ON "ServiceSettings"("isBlocked");

-- CreateIndex
CREATE INDEX "SessionLog_userId_idx" ON "SessionLog"("userId");

-- CreateIndex
CREATE INDEX "SessionLog_isActive_expiresAt_idx" ON "SessionLog"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "Subscriber_status_idx" ON "Subscriber"("status");

-- CreateIndex
CREATE INDEX "Subscriber_packageId_idx" ON "Subscriber"("packageId");

-- CreateIndex
CREATE INDEX "Subscriber_areaId_idx" ON "Subscriber"("areaId");

-- CreateIndex
CREATE INDEX "Subscriber_nasId_idx" ON "Subscriber"("nasId");

-- CreateIndex
CREATE INDEX "Subscriber_userId_idx" ON "Subscriber"("userId");

-- CreateIndex
CREATE INDEX "Subscriber_salespersonId_idx" ON "Subscriber"("salespersonId");

-- CreateIndex
CREATE INDEX "Subscriber_createdAt_idx" ON "Subscriber"("createdAt");

-- CreateIndex
CREATE INDEX "Subscriber_phone_idx" ON "Subscriber"("phone");

-- CreateIndex
CREATE INDEX "SystemLog_level_idx" ON "SystemLog"("level");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE INDEX "Ticket_subscriberId_idx" ON "Ticket"("subscriberId");

-- CreateIndex
CREATE INDEX "Ticket_status_priority_idx" ON "Ticket"("status", "priority");

-- CreateIndex
CREATE INDEX "Ticket_assignedTo_idx" ON "Ticket"("assignedTo");

-- CreateIndex
CREATE INDEX "Ticket_createdAt_idx" ON "Ticket"("createdAt");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE INDEX "User_parentId_idx" ON "User"("parentId");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "Voucher_status_idx" ON "Voucher"("status");

-- CreateIndex
CREATE INDEX "Voucher_batchId_idx" ON "Voucher"("batchId");

-- CreateIndex
CREATE INDEX "Voucher_usedBy_idx" ON "Voucher"("usedBy");

-- CreateIndex
CREATE INDEX "packages_poolId_idx" ON "packages"("poolId");

-- CreateIndex
CREATE INDEX "packages_isActive_idx" ON "packages"("isActive");

-- CreateIndex
CREATE INDEX "radpostauth_authdate_idx" ON "radpostauth"("authdate");
