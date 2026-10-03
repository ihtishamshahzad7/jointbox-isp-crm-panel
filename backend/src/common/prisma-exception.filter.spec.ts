import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

const known = (code: string, meta: any = {}) =>
  new Prisma.PrismaClientKnownRequestError(`Invalid \`prisma.x.create()\` invocation: secret-value-123`, {
    code,
    clientVersion: 'test',
    meta,
  });

function host(type = 'http', headersSent = false) {
  const res: any = { headersSent, status: jest.fn(() => res), json: jest.fn(() => res) };
  const req = { method: 'POST', route: { path: '/communication/templates' } };
  return {
    res,
    h: { getType: () => type, switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as any,
  };
}

describe('database errors reach the user as 4xx with a plain sentence', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('duplicate → 409 naming the field, never the company scoping column', () => {
    const { res, h } = host();
    new PrismaExceptionFilter().catch(known('P2002', { target: ['ownerId', 'name'] }), h);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toMatch(/this name/);
    expect(body.message).not.toMatch(/ownerId/);
  });

  it('record gone → 404; still in use → 409; bad value → 400', () => {
    expect(PrismaExceptionFilter.describe(known('P2025')).status).toBe(404);
    expect(PrismaExceptionFilter.describe(known('P2003')).status).toBe(409);
    expect(PrismaExceptionFilter.describe(known('P2000')).status).toBe(400);
    expect(PrismaExceptionFilter.describe(new Prisma.PrismaClientValidationError('x', { clientVersion: 't' })).status).toBe(400);
    expect(PrismaExceptionFilter.describe(known('P9999')).status).toBe(500);
  });

  it('never logs or returns the Prisma message (it can carry query values)', () => {
    const { res, h } = host();
    new PrismaExceptionFilter().catch(known('P2002', { target: ['name'], modelName: 'MessageTemplate' }), h);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/P2002 on MessageTemplate/);
    expect(logged).not.toMatch(/secret-value-123/);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/secret-value-123/);
  });

  it('does not write twice to a response that already started (SSE, streams)', () => {
    const { res, h } = host('http', true);
    new PrismaExceptionFilter().catch(known('P2025'), h);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('leaves non-HTTP contexts alone', () => {
    const { h } = host('rpc');
    expect(() => new PrismaExceptionFilter().catch(known('P2025'), h)).toThrow();
  });

  it('is installed globally', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).toMatch(/useGlobalFilters\(new PrismaExceptionFilter\(\)\)/);
  });
});
