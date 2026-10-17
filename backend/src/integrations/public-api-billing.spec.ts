import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';

/**
 * POST /api/v1/billing/run/:type never ran a billing job, yet answered 200 with
 * "triggered". A caller automating invoices could not tell nothing happened.
 */
describe('public API billing trigger is honest', () => {
  const ctrl = Object.create(
    PublicApiController.prototype,
  ) as PublicApiController;

  it('refuses an unknown type with 400', () => {
    expect(() => ctrl.triggerBilling('everything')).toThrow(
      BadRequestException,
    );
  });

  it('answers 501, never a success, for a valid type', () => {
    for (const t of ['auto-invoice', 'auto-renewal', 'suspension']) {
      expect(() => ctrl.triggerBilling(t, 'true')).toThrow(
        NotImplementedException,
      );
    }
  });
});
