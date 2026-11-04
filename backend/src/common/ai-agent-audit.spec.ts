import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { PrismaService } from '../prisma/prisma.service';

describe('AuditInterceptor AI Agent prompt handling', () => {
  it('audits a chat request without persisting its prompt text', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor({
      activityLog: { create },
    } as unknown as PrismaService);
    const req = {
      method: 'POST',
      originalUrl: '/ai-agent/chat',
      url: '/ai-agent/chat',
      body: { question: 'private customer details requested here' },
      params: {},
      headers: { 'user-agent': 'test' },
      user: { sub: 17 },
      ip: '127.0.0.1',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const handler = { handle: () => of({ ok: true }) } as CallHandler;

    await firstValueFrom(interceptor.intercept(context, handler));

    const details = create.mock.calls[0][0].data.details as string;
    expect(details).toContain('AI prompt and answer intentionally omitted');
    expect(details).not.toContain('private customer details requested here');
  });
});
