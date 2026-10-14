/**
 * RADIUS TENANCY FOR EVERYTHING THE PANEL SENDS TO A ROUTER ABOUT A SUBSCRIBER.
 *
 * The same rule FreeRADIUS applies at login (database function
 * jointbox_radius_tenancy, kind 'coa'; docs/RADIUS_TENANCY.md): a CoA,
 * Disconnect-Request or router-API call about a subscriber goes only to a
 * router the policy would let that subscriber log in on. Otherwise one
 * company's router — and its shared secret or API login — would be used for
 * another company's subscriber, and that subscriber's session id and address
 * handed to it.
 *
 * mode off: always allowed. monitor: allowed, the would-be refusal recorded.
 * enforce: refused. Check unavailable (no answer from the database): refused —
 * fail closed, like FreeRADIUS.
 */

export const TENANCY_REFUSED =
  "Not sent: this router is not one of the subscriber's company's routers (RADIUS tenancy policy).";

interface RawQuery {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

export async function radiusTenancyAllows(
  prisma: RawQuery,
  username: string | null | undefined,
  nasIp: string | null | undefined,
  logger?: { warn(message: string): void },
): Promise<boolean> {
  if (!username || !nasIp) return false;
  try {
    const rows = await prisma.$queryRaw<Array<{ r: string }>>`
      SELECT public.jointbox_radius_tenancy('coa', ${String(username)}, ${String(nasIp)}) AS r`;
    const decision = String(rows?.[0]?.r ?? '');
    if (decision === 'allow' || decision.startsWith('monitor:')) return true;
    logger?.warn(
      `Not sent to router ${nasIp}: ${decision || 'no decision'} (RADIUS tenancy policy)`,
    );
    return false;
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code || 'database error';
    logger?.warn(
      `Not sent to router ${nasIp}: tenancy check unavailable (${code})`,
    );
    return false;
  }
}
