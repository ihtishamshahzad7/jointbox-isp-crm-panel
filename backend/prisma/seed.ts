import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('admin123', 10);
  
  // `update: {}` — an EXISTING account is left exactly as it is. This used to
  // reset the password back to admin123 on every run, so running the seed on a
  // live server silently reopened the owner account with the published
  // default. Creating is fine; overwriting someone's chosen password is not.
  const admin = await prisma.user.upsert({
    where: { email: 'admin@jointbox.com' },
    update: {},
    create: {
      name: 'Super Admin',
      email: 'admin@jointbox.com',
      password: hashedPassword,
      role: 'SUPER_ADMIN',
      isActive: true,
      mustChangePassword: true,
    },
  });

  console.log('Admin user ready:', admin.email, '(default password must be changed at first login)');
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });