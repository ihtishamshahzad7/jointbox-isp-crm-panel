#!/usr/bin/env node
/**
 * Sign-in rescue for the platform (super admin) account.
 *
 * Run on the server, from the backend folder:
 *
 *   node scripts/reset-platform-password.js
 *       Lists the platform account(s): email, active, must-change flag.
 *       Nothing is changed and no password is shown.
 *
 *   node scripts/reset-platform-password.js --email superadmin@yourdomain
 *       Asks for a new password twice (typing is hidden), saves it, unlocks
 *       the account, signs out every open session and makes the panel ask
 *       for a fresh password at the next sign-in.
 *
 * The password is never printed, never logged and never taken from the
 * command line (that would leave it in the shell history and in `ps`).
 * For automation only, it may be passed in the RESET_PASSWORD environment
 * variable instead of being typed.
 *
 * Uses DATABASE_URL from backend/.env.
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true }); } catch { /* env already set */ }
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function policyProblem(pw) {
  const min = Number(process.env.PASSWORD_MIN_LENGTH) || 8;
  if (!pw || pw.length < min) return `at least ${min} characters`;
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'letters and numbers';
  return null;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: read one line without echo handling.
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] || ''));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); return; }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const prisma = new PrismaClient();
  try {
    const platform = await prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', isDemo: false },
      select: { id: true, email: true, name: true, isActive: true, mustChangePassword: true },
      orderBy: { id: 'asc' },
    });

    const email = arg('email');
    if (!email) {
      if (!platform.length) {
        console.log('No platform account yet. Start the backend once (pm2 restart all) — it creates one at boot');
        console.log('and writes "👑 Platform account created: <email>" to the backend log (pm2 logs).');
        return;
      }
      console.log('Platform (super admin) account(s):');
      for (const u of platform) {
        console.log(`  ${u.email}   ${u.isActive ? 'active' : 'DISABLED'}${u.mustChangePassword ? '   (must change password at next sign-in)' : ''}`);
      }
      console.log('\nTo set a new password:  node scripts/reset-platform-password.js --email <email above>');
      return;
    }

    const user = platform.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
    if (!user) {
      console.error(`"${email}" is not a platform account. Run without --email to list them.`);
      process.exitCode = 1;
      return;
    }

    let pw = process.env.RESET_PASSWORD || '';
    if (!pw) {
      pw = await askHidden('New password: ');
      const again = await askHidden('Repeat it:    ');
      if (pw !== again) { console.error('The two passwords do not match. Nothing was changed.'); process.exitCode = 1; return; }
    }
    const problem = policyProblem(pw);
    if (problem) { console.error(`The password needs ${problem}. Nothing was changed.`); process.exitCode = 1; return; }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(pw, 10),
        isActive: true,
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    });
    console.log(`Done. Sign in as ${user.email} with the new password; the panel will ask you to choose your own.`);
    console.log('Every session that was open on this account has been signed out.');
    console.log('If sign-in still says "too many attempts", restart the backend (pm2 restart all) to clear the lock.');
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';
    console.error(`Could not reach the database (check DATABASE_URL in backend/.env): ${msg.slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})();
