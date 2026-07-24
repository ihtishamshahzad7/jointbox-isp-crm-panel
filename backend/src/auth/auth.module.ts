import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './auth.guard';
import { TokenBlacklistService } from './token-blacklist.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [
    PrismaModule,
    LogsModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, TokenBlacklistService],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}