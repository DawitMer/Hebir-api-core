import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { buildSocketCors } from '../../config/security.config';
import { AuthService } from '../auth/auth.service';
import { isAccountClosed } from '../auth/entities/user-account.entity';
import { PushService } from '../push/push.service';

const NOTIFICATIONS_CHANNEL = 'notifications';

type SocketWithUser = Socket & { data: { userId?: string } };

/**
 * Drivers must be asked to accept a rider within the seat-hold window
 * (blueprint section 2). Socket traffic is relayed through Redis pub/sub
 * so a driver connected to one server still receives a notification
 * produced by another (blueprint section 4).
 *
 * The connecting identity comes from the access token, never from the
 * handshake query: a client-supplied `userId` would let anyone subscribe to
 * another user's ride offers and pickup addresses.
 */
@WebSocketGateway({ cors: buildSocketCors() })
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private readonly userSockets = new Map<string, Set<string>>();
  private readonly subscriber: Redis;
  private readonly allowUnauthenticated: boolean;

  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly jwt: JwtService,
    private readonly authService: AuthService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    // Escape hatch for local demos whose clients still connect with only a
    // userId. Never honoured in production.
    this.allowUnauthenticated =
      config.get<string>('NODE_ENV') !== 'production' &&
      config.get<string>('WS_ALLOW_UNAUTHENTICATED') === 'true';
    if (this.allowUnauthenticated) {
      this.logger.warn(
        'WS_ALLOW_UNAUTHENTICATED=true — socket clients may self-declare userId (dev only)',
      );
    }

    this.subscriber = this.redis.duplicate();
    this.subscriber.subscribe(NOTIFICATIONS_CHANNEL).catch((error) => {
      this.logger.error(`Notification subscribe failed: ${error.message}`);
    });
    this.subscriber.on('message', (_channel, message) => {
      // A malformed payload must not surface as an unhandled error on the
      // ioredis event emitter (which would take the process down).
      try {
        const { userId, event, payload } = JSON.parse(message);
        if (typeof userId === 'string' && typeof event === 'string') {
          this.emitToUser(userId, event, payload);
        }
      } catch (error) {
        this.logger.warn(`Dropped malformed notification: ${error.message}`);
      }
    });
    this.subscriber.on('error', (error) => {
      this.logger.warn(`Notification subscriber error: ${error.message}`);
    });
  }

  async handleConnection(socket: SocketWithUser) {
    const userId = await this.resolveUserId(socket);
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    socket.data.userId = userId;
    const sockets = this.userSockets.get(userId) ?? new Set<string>();
    sockets.add(socket.id);
    this.userSockets.set(userId, sockets);
  }

  handleDisconnect(socket: SocketWithUser) {
    const userId = socket.data?.userId;
    if (!userId) return;
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (sockets.size === 0) this.userSockets.delete(userId);
  }

  async onModuleDestroy() {
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
  }

  /**
   * Same rules as the HTTP JwtStrategy: valid access token, jti not
   * revoked, account still exists and is not banned. A suspended user must
   * lose their socket, not just their REST access.
   */
  private async resolveUserId(socket: SocketWithUser): Promise<string | null> {
    const token = this.extractToken(socket);
    if (token) {
      try {
        const payload = this.jwt.verify<{
          sub?: string;
          typ?: string;
          jti?: string;
        }>(token);
        if (payload.typ && payload.typ !== 'access') return null;
        if (!payload.sub) return null;
        if (await this.authService.isAccessJtiDenied(payload.jti)) {
          this.logger.warn(
            `Rejected socket with revoked token (user ${payload.sub})`,
          );
          return null;
        }
        const context = await this.authService.getAuthContext(payload.sub);
        if (!context || isAccountClosed(context.standing)) {
          this.logger.warn(`Rejected socket for closed account ${payload.sub}`);
          return null;
        }
        return payload.sub;
      } catch (error) {
        this.logger.warn(
          `Rejected socket with invalid token: ${error.message}`,
        );
        return null;
      }
    }

    if (!this.allowUnauthenticated) return null;
    const declared = socket.handshake.query.userId;
    return typeof declared === 'string' && declared ? declared : null;
  }

  private extractToken(socket: SocketWithUser): string | null {
    const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)
      ?.token;
    if (typeof fromAuth === 'string' && fromAuth)
      return fromAuth.replace(/^Bearer /i, '');

    const fromQuery = socket.handshake.query.token;
    if (typeof fromQuery === 'string' && fromQuery)
      return fromQuery.replace(/^Bearer /i, '');

    const header = socket.handshake.headers.authorization;
    if (
      typeof header === 'string' &&
      header.toLowerCase().startsWith('bearer ')
    ) {
      return header.slice(7);
    }
    return null;
  }

  private emitToUser(userId: string, event: string, payload: unknown) {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, payload);
    }
  }

  /** Publishes to Redis so any server instance can deliver it. */
  async notify(userId: string, event: string, payload: unknown) {
    await this.redis.publish(
      NOTIFICATIONS_CHANNEL,
      JSON.stringify({ userId, event, payload }),
    );
    void this.push.notifyEvent(userId, event, payload).catch((error) => {
      this.logger.warn(
        `FCM ${event} → ${userId} failed: ${(error as Error).message}`,
      );
    });
  }
}
