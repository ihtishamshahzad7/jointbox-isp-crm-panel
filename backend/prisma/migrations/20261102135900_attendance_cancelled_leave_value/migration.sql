-- PostgreSQL only lets a new enum value be used after it is committed, so it
-- is added in its own migration, before crm_advanced_leave uses it.
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'CANCELLED_LEAVE';
