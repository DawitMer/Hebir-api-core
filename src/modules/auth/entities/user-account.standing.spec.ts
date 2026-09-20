import {
  AccountStanding,
  isAccountClosed,
  isMarketplaceBlocked,
} from './user-account.entity';

describe('account standing gates', () => {
  it('treats banned and deleted as closed', () => {
    expect(isAccountClosed(AccountStanding.BANNED)).toBe(true);
    expect(isAccountClosed(AccountStanding.DELETED)).toBe(true);
    expect(isAccountClosed(AccountStanding.FLAGGED)).toBe(false);
    expect(isAccountClosed(AccountStanding.GOOD)).toBe(false);
  });

  it('blocks flagged accounts from the marketplace without closing login', () => {
    expect(isMarketplaceBlocked(AccountStanding.FLAGGED)).toBe(true);
    expect(isMarketplaceBlocked(AccountStanding.BANNED)).toBe(true);
    expect(isMarketplaceBlocked(AccountStanding.GOOD)).toBe(false);
  });
});
