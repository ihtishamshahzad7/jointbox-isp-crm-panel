import { Module } from '@nestjs/common';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { PaymentGatewaysService } from './payment-gateways.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [PaymentGatewaysController],
  providers: [PaymentGatewaysService],
  exports: [PaymentGatewaysService],
})
export class PaymentGatewaysModule {}
