import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SubscriptionService } from '../../modules/subscription/subscription.service';

/**
 * Blueprint 5.4 — the access gate. Blocks publishing/editing trips,
 * accepting/declining riders, and going online for any driver whose
 * subscription is not active. Refuses with a reason the mobile app can
 * use to route straight to the renewal screen.
 */
@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const driverId = request.user?.userId;

    if (!this.subscriptionService.isEnforced()) return true;

    const active = await this.subscriptionService.isActive(driverId);
    if (!active) {
      throw new ForbiddenException({
        message: 'Active subscription required',
        reason: 'subscription_inactive',
      });
    }
    return true;
  }
}
