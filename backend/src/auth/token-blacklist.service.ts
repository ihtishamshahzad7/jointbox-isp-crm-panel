import { Injectable } from '@nestjs/common';

@Injectable()
export class TokenBlacklistService {
  private blacklist = new Set<string>();

  add(token: string) {
    this.blacklist.add(token);
    // Auto-remove after 7 days (max token lifetime)
    setTimeout(() => this.blacklist.delete(token), 7 * 24 * 60 * 60 * 1000);
  }

  isBlacklisted(token: string): boolean {
    return this.blacklist.has(token);
  }
}
