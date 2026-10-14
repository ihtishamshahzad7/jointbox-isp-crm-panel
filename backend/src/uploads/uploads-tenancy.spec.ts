import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UploadsController, UPLOAD_DIR } from './uploads.controller';
import { ScopeService } from '../common/scope.service';

/**
 * UPLOADED FILES — CNIC scans and photos.
 *
 * They used to be served statically to anyone with the URL. Now: a media
 * token is required, a recorded file is shown only to its own company, and
 * nothing but a media token is accepted in the URL.
 *
 *   1 SUPER_ADMIN ─┬─ 10 ADMIN (company A) ── 11 RESELLER
 *                  └─ 20 ADMIN (company B)
 */
const USERS: Record<number, { parentId: number | null; role: string; isActive: boolean }> = {
  1: { parentId: null, role: 'SUPER_ADMIN', isActive: true },
  10: { parentId: 1, role: 'ADMIN', isActive: true },
  11: { parentId: 10, role: 'RESELLER', isActive: true },
  20: { parentId: 1, role: 'ADMIN', isActive: true },
  21: { parentId: 20, role: 'RESELLER', isActive: false },
  30: { parentId: 1, role: 'ADMIN', isActive: false },
  31: { parentId: 30, role: 'RESELLER', isActive: true },
};
const FILES: Record<string, { ownerId: number | null }> = { 'a-cnic.png': { ownerId: 10 }, 'platform-logo.png': { ownerId: null } };

function make() {
  const created: any[] = [];
  const prisma: any = {
    $queryRaw: jest.fn(async (q: any, ...vals: any[]) => {
      const sql = Array.isArray(q) ? q.join('?') : '';
      const id = Number(vals[0]);
      // account-status: active = self and every ancestor active
      if (sql.includes('bool_and')) {
        let ok = true;
        for (let cur: number | null = id; cur != null && USERS[cur]; cur = USERS[cur].parentId) ok = ok && USERS[cur].isActive;
        return [{ ok }];
      }
      if (sql.includes('WITH RECURSIVE up')) {
        const out: number[] = [];
        for (let cur: number | null = id; cur != null && USERS[cur]; cur = USERS[cur].parentId) out.push(cur);
        return out.map((x) => ({ id: x }));
      }
      return [];
    }),
    user: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: number) => ({ id, role: USERS[id]?.role }))),
      findUnique: jest.fn(async ({ where }: any) =>
        USERS[where.id] ? { role: USERS[where.id].role, isActive: USERS[where.id].isActive, mustChangePassword: false } : null,
      ),
    },
    uploadedFile: {
      findUnique: jest.fn(async ({ where }: any) => FILES[where.filename] ?? null),
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
    },
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  const ctl = new UploadsController(prisma, new ScopeService(prisma), jwt);
  return { ctl, jwt, created };
}

const res = () => ({ setHeader: jest.fn(), sendFile: jest.fn() });

describe('uploads: who can open a CNIC scan', () => {
  const tmp = ['a-cnic.png', 'legacy.png', 'platform-logo.png'].map((n) => path.join(UPLOAD_DIR, n));
  beforeAll(() => tmp.forEach((p) => fs.writeFileSync(p, 'x')));
  afterAll(() => tmp.forEach((p) => fs.rmSync(p, { force: true })));

  const media = (jwt: JwtService, sub: number, extra: any = {}) => jwt.sign({ sub, scope: 'media', ...extra });

  it('the owning company opens its own file; its dealers too', async () => {
    const { ctl, jwt } = make();
    for (const sub of [10, 11]) {
      const r = res();
      await ctl.serve('a-cnic.png', media(jwt, sub), {}, r);
      expect(r.sendFile).toHaveBeenCalled();
    }
  });

  it("another company gets 404 for company A's file", async () => {
    const { ctl, jwt } = make();
    await expect(ctl.serve('a-cnic.png', media(jwt, 20), {}, res())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the platform account never opens a company's files — only its own", async () => {
    const { ctl, jwt } = make();
    await expect(ctl.serve('a-cnic.png', media(jwt, 1), {}, res())).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.serve('legacy.png', media(jwt, 1), {}, res())).rejects.toBeInstanceOf(NotFoundException);
    const r = res();
    await ctl.serve('platform-logo.png', media(jwt, 1), {}, r);
    expect(r.sendFile).toHaveBeenCalled();
  });

  it('a file from before the registry is open to any signed-in operator, never to the public', async () => {
    const { ctl, jwt } = make();
    const r = res();
    await ctl.serve('legacy.png', media(jwt, 20), {}, r);
    expect(r.sendFile).toHaveBeenCalled();
    await expect(ctl.serve('legacy.png', undefined as any, { headers: {} }, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an operator token or a portal token in the URL — media tokens only', async () => {
    const { ctl, jwt } = make();
    await expect(ctl.serve('legacy.png', jwt.sign({ sub: 10, role: 'ADMIN' }), {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.serve('legacy.png', jwt.sign({ sub: 10, scope: 'admin' }), {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.serve('legacy.png', jwt.sign({ sub: 10, scope: 'subscriber' }), {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a forged or expired token', async () => {
    const { ctl } = make();
    const other = new JwtService({ secret: 'not-ours' }).sign({ sub: 1, scope: 'media' });
    await expect(ctl.serve('legacy.png', other, {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a suspended account, and the dealers of a suspended company', async () => {
    const { ctl, jwt } = make();
    await expect(ctl.serve('legacy.png', media(jwt, 21), {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.serve('legacy.png', media(jwt, 31), {}, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses path tricks', async () => {
    const { ctl, jwt } = make();
    for (const bad of ['../.env', '..', '.htaccess', 'a/b.png', 'a\\b.png', '']) {
      await expect(ctl.serve(bad, media(jwt, 1), {}, res())).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe('uploads: storing a file', () => {
  it('names stored files with crypto randomness, not Math.random', () => {
    const src = fs.readFileSync(path.join(__dirname, 'uploads.controller.ts'), 'utf8');
    expect(src).toMatch(/randomBytes\(16\)/);
    expect(src).not.toMatch(/Math\.random\(\)\s*\*/);
  });

  it("records the file against the uploader's company", async () => {
    const { ctl, created } = make();
    const tmp = path.join(require('os').tmpdir(), `up-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const r = await ctl.upload({ filename: '1-abc.png', mimetype: 'image/png', size: 3, path: tmp }, { user: { sub: 11, role: 'RESELLER' } });
    fs.rmSync(tmp, { force: true });
    expect(r).toEqual({ url: '/uploads/1-abc.png', filename: '1-abc.png' });
    expect(created[0]).toMatchObject({ filename: '1-abc.png', ownerId: 10, uploadedBy: 11 });
  });

  it('an HTML page declared as an image is refused and deleted', async () => {
    const { ctl, created } = make();
    const tmp = path.join(require('os').tmpdir(), `up-${Date.now()}.png`);
    fs.writeFileSync(tmp, '<html><script>alert(localStorage.token)</script></html>');
    await expect(ctl.upload({ filename: 'x.png', mimetype: 'image/png', size: 9, path: tmp }, { user: { sub: 11, role: 'RESELLER' } }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('stored names take their extension from the checked type, never the client', () => {
    const src = fs.readFileSync(path.join(__dirname, 'uploads.controller.ts'), 'utf8');
    expect(src).toMatch(/EXT_FOR\[String\(file\.mimetype\)\.toLowerCase\(\)\] \|\| '\.bin'/);
    expect(src).not.toMatch(/extname\(file\.originalname\)/);
    expect(src).toMatch(/Content-Security-Policy/);
  });

  it('rejects a request with no file', async () => {
    const { ctl } = make();
    await expect(ctl.upload(undefined, { user: { sub: 10 } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('there is no static mount in front of the controller', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).not.toMatch(/useStaticAssets\([^)]*uploads/);
  });

  it('a media token is a separate scope the operator API refuses', () => {
    const strat = fs.readFileSync(path.join(__dirname, '..', 'auth', 'jwt.strategy.ts'), 'utf8');
    expect(strat).toMatch(/payload\.scope !== 'admin'/);
    void os;
  });
});
