import { Controller, Post } from '@nestjs/common';
import { DemoService } from './demo.service';

/**
 * Public demo-account creation. No auth required — anyone can spin up a
 * sandbox franchise account to try the panel; it self-destructs in 7 days.
 */
@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post('create')
  create() {
    return this.demo.create();
  }
}
