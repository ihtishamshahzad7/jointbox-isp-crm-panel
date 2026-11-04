import { FieldJobType, TicketPriority } from '@prisma/client';

export class UpdateFieldJobScheduleDto {
  type?: FieldJobType;
  priority?: TicketPriority;
  description?: string;
  workInstructions?: string | null;
  address?: string | null;
  frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval?: number | string;
  timeZone?: string;
  startAtLocal?: string;
  endAtLocal?: string | null;
  subscriberId?: number | string | null;
  ticketId?: number | string | null;
  leadId?: number | string | null;
}
