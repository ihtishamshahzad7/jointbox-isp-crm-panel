import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UploadsController } from './uploads.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    // Same secret as the operator API: media tokens are verified here and
    // refused everywhere else by their scope.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
    }),
  ],
  controllers: [UploadsController],
})
export class UploadsModule {}
