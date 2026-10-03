import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Database errors nobody caught, turned into answers a person can act on.
 *
 * Without this, a duplicate name, a delete blocked by linked records or a
 * stale id all came back as "500 Internal server error" — and Nest logged the
 * whole Prisma message, which for a validation error prints every argument of
 * the query (password hashes and tokens included). Here the client gets a
 * 4xx with a plain sentence, and the log gets the code and model only.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Database');

  catch(e: any, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw e;
    const res: any = host.switchToHttp().getResponse();
    const req: any = host.switchToHttp().getRequest();
    const { status, message } = PrismaExceptionFilter.describe(e);
    // Code and model only — never e.message (it can carry query values).
    const where = `${req?.method ?? ''} ${String(req?.route?.path ?? req?.path ?? '')}`.trim();
    const what = e instanceof Prisma.PrismaClientKnownRequestError
      ? `${e.code}${e.meta?.modelName ? ` on ${e.meta.modelName}` : ''}`
      : 'invalid query arguments';
    this.logger.warn(`${where}: ${what} → ${status}`);
    if (res?.headersSent) return;
    res.status(status).json({ statusCode: status, message, error: PrismaExceptionFilter.label(status) });
  }

  static describe(e: any): { status: number; message: string } {
    if (e instanceof Prisma.PrismaClientValidationError) {
      return { status: 400, message: 'Some of the values sent are not valid for this form.' };
    }
    const meta: any = e?.meta ?? {};
    switch (e?.code) {
      case 'P2002': {
        const raw = Array.isArray(meta.target) ? meta.target : [];
        // ownerId is how a record is scoped to its company, not something a user typed.
        const fields = raw.map(String).filter((f: string) => f !== 'ownerId' && f !== 'id');
        return {
          status: 409,
          message: fields.length
            ? `Another record already uses this ${fields.join(' and ')}. Choose a different one.`
            : 'That already exists. Choose a different name.',
        };
      }
      case 'P2025':
      case 'P2001':
      case 'P2018':
        return { status: 404, message: 'Not found. It may have just been deleted — reload the page.' };
      case 'P2003':
      case 'P2014':
        return {
          status: 409,
          message: 'This is linked to other records. Remove or reassign those first (or pick an item that exists).',
        };
      case 'P2000':
        return { status: 400, message: 'One of the values is too long.' };
      case 'P2005':
      case 'P2006':
      case 'P2007':
      case 'P2011':
      case 'P2012':
      case 'P2013':
      case 'P2019':
      case 'P2020':
      case 'P2023':
        return { status: 400, message: 'Some of the values sent are missing or not valid.' };
      case 'P2034':
        return { status: 409, message: 'Someone else changed this at the same moment. Try again.' };
      default:
        return { status: 500, message: 'Database error. Try again; if it keeps happening, contact support.' };
    }
  }

  private static label(status: number) {
    return status === 400 ? 'Bad Request' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Internal Server Error';
  }
}
