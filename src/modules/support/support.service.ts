import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import {
  SupportThread,
  SupportThreadStatus,
} from './entities/support-thread.entity';
import {
  SupportMessage,
  SupportSenderRole,
} from './entities/support-message.entity';
import { UserAccount, UserRole } from '../auth/entities/user-account.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';

import { ListRideMessagesDto } from '../rides/dto/list-ride-messages.dto';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportThread)
    private readonly threads: Repository<SupportThread>,
    @InjectRepository(SupportMessage)
    private readonly messages: Repository<SupportMessage>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    private readonly notifications: NotificationsGateway,
  ) {}

  async getOrCreateMine(
    userId: string,
    roles: string[],
    query: ListRideMessagesDto = {},
  ) {
    const userRole = roles.includes(UserRole.DRIVER) ? 'driver' : 'rider';
    const thread = await this.threads.manager.transaction(async (em) => {
      const user = await em.findOne(UserAccount, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Account not found');
      // Keep closed history visible. A new user message reopens this same thread.
      const existing = await em.findOne(SupportThread, {
        where: { userId },
        order: { lastMessageAt: 'DESC' },
      });
      if (existing) return existing;
      const created = await em.save(
        em.create(SupportThread, {
          userId,
          userRole,
          status: SupportThreadStatus.OPEN,
          assignedAgentId: null,
          lastMessageAt: new Date(),
        }),
      );
      await em.save(
        em.create(SupportMessage, {
          threadId: created.id,
          senderId: userId,
          senderRole: SupportSenderRole.SYSTEM,
          senderName: 'ህብር Support',
          body: 'A support agent will reply here. This conversation is saved so any agent can pick it up.',
        }),
      );
      return created;
    });
    return this.threadPayload(thread, query);
  }

  async postUserMessage(
    userId: string,
    roles: string[],
    body: string,
    clientMessageId?: string,
  ) {
    const { thread } = await this.getOrCreateMine(userId, roles);
    const user = await this.users.findOne({ where: { id: userId } });
    return this.appendMessage({
      threadId: thread.id,
      senderId: userId,
      senderRole: SupportSenderRole.USER,
      senderName: user?.fullName || user?.phoneNumber || 'Customer',
      body,
      notifyUserId: userId,
      clientMessageId,
    });
  }

  async listThreads(
    status?: string,
    opts?: { limit?: number; before?: string },
  ) {
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
    const qb = this.threads
      .createQueryBuilder('t')
      .orderBy('t.lastMessageAt', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(limit);
    if (status === 'open' || status === 'closed') {
      qb.andWhere('t.status = :status', { status });
    }
    if (opts?.before) {
      const cursor = await this.threads.findOne({ where: { id: opts.before } });
      if (!cursor) throw new BadRequestException('Invalid thread cursor');
      qb.andWhere(
        '(t."lastMessageAt", t.id) < (:lastMessageAt, :id)',
        { lastMessageAt: cursor.lastMessageAt, id: cursor.id },
      );
    }
    const rows = await qb.getMany();
    if (!rows.length) return [];
    const users = await this.users.find({
      where: { id: In(rows.map((r) => r.userId)) },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const lastByThread = await this.lastMessages(rows.map((r) => r.id));
    return rows.map((thread) => {
      const user = byId.get(thread.userId);
      const last = lastByThread.get(thread.id);
      return {
        id: thread.id,
        status: thread.status,
        userId: thread.userId,
        userRole: thread.userRole,
        userName: user?.fullName || user?.phoneNumber || 'Unknown',
        userPhone: user?.phoneNumber ?? null,
        assignedAgentId: thread.assignedAgentId,
        lastMessageAt: thread.lastMessageAt,
        lastMessagePreview: last?.body?.slice(0, 140) ?? '',
        lastSenderRole: last?.senderRole ?? null,
        createdAt: thread.createdAt,
      };
    });
  }

  async getThreadForStaff(threadId: string, query: ListRideMessagesDto = {}) {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Support thread not found');
    return this.threadPayload(thread, query);
  }

  async postAgentMessage(
    threadId: string,
    agentId: string,
    body: string,
    clientMessageId?: string,
  ) {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Support thread not found');
    const agent = await this.users.findOne({ where: { id: agentId } });
    return this.appendMessage({
      threadId,
      senderId: agentId,
      senderRole: SupportSenderRole.AGENT,
      senderName: agent?.fullName || agent?.phoneNumber || 'Support agent',
      body,
      notifyUserId: thread.userId,
      clientMessageId,
    });
  }

  async updateThread(
    threadId: string,
    agentId: string,
    patch: { status?: 'open' | 'closed' },
  ) {
    const thread = await this.threads.manager.transaction(async (em) => {
      const current = await em.findOne(SupportThread, {
        where: { id: threadId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Support thread not found');
      if (patch.status) current.status = patch.status as SupportThreadStatus;
      current.assignedAgentId = agentId;
      return em.save(current);
    });
    return this.threadPayload(thread);
  }

  private async appendMessage(input: {
    threadId: string;
    senderId: string;
    senderRole: SupportSenderRole;
    senderName: string;
    body: string;
    notifyUserId: string | null;
    clientMessageId?: string;
  }) {
    const trimmed = input.body.trim();
    if (!trimmed || trimmed.length > 2000)
      throw new BadRequestException('Use 1–2000 characters');
    let message: SupportMessage;
    try {
      message = await this.messages.manager.transaction(async (em) => {
        const thread = await em.findOne(SupportThread, {
          where: { id: input.threadId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!thread) throw new NotFoundException('Support thread not found');
        const saved = await em.save(
          em.create(SupportMessage, {
            threadId: input.threadId,
            senderId: input.senderId,
            senderRole: input.senderRole,
            senderName: input.senderName.slice(0, 120),
            body: trimmed,
            clientMessageId: input.clientMessageId ?? null,
          }),
        );
        await em.update(SupportThread, thread.id, {
          lastMessageAt: saved.createdAt,
          status: SupportThreadStatus.OPEN,
          assignedAgentId:
            thread.assignedAgentId ??
            (input.senderRole === SupportSenderRole.AGENT
              ? input.senderId
              : null),
        });
        return saved;
      });
    } catch (error) {
      if (
        !(error instanceof QueryFailedError) ||
        (error.driverError as { code?: string }).code !== '23505' ||
        !input.clientMessageId
      )
        throw error;
      const saved = await this.messages.findOne({
        where: {
          threadId: input.threadId,
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      });
      if (!saved || saved.body !== trimmed)
        throw new ConflictException('Message id already used');
      return this.mapMessage(saved);
    }
    if (input.notifyUserId) {
      try {
        await this.notifications.notify(
          input.notifyUserId,
          'support.chat_message',
          {
            threadId: input.threadId,
            message: this.mapMessage(message),
          },
        );
      } catch (error) {
        this.logger.warn(`support notify failed: ${(error as Error).message}`);
      }
    }
    return this.mapMessage(message);
  }

  private async threadPayload(
    thread: SupportThread,
    query: ListRideMessagesDto = {},
  ) {
    const user = await this.users.findOne({ where: { id: thread.userId } });
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));
    const builder = this.messages
      .createQueryBuilder('m')
      .where('m.threadId = :threadId', { threadId: thread.id });
    if (query.before) {
      const cursor = await this.messages.findOne({
        where: { id: query.before, threadId: thread.id },
      });
      if (!cursor) throw new BadRequestException('Invalid message cursor');
      builder.andWhere(
        '(m."createdAt", m.id) < (SELECT "createdAt", id FROM support_messages WHERE id = :before)',
        { before: query.before },
      );
    }
    const rows = await builder
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1)
      .getMany();
    const messages = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? messages[messages.length - 1].id : null;
    messages.reverse();
    return {
      thread: {
        id: thread.id,
        status: thread.status,
        userId: thread.userId,
        userRole: thread.userRole,
        userName: user?.fullName || user?.phoneNumber || 'Unknown',
        userPhone: user?.phoneNumber ?? null,
        assignedAgentId: thread.assignedAgentId,
        lastMessageAt: thread.lastMessageAt,
        createdAt: thread.createdAt,
      },
      messages: messages.map((m) => this.mapMessage(m)),
      nextCursor,
    };
  }

  private mapMessage(message: SupportMessage) {
    return {
      id: message.id,
      threadId: message.threadId,
      senderId: message.senderId,
      clientMessageId: message.clientMessageId,
      status: 'sent',
      senderRole: message.senderRole,
      senderName: message.senderName,
      body: message.body,
      createdAt: message.createdAt,
    };
  }

  private async lastMessages(threadIds: string[]) {
    const map = new Map<string, SupportMessage>();
    if (!threadIds.length) return map;
    const rows = await this.messages
      .createQueryBuilder('m')
      .distinctOn(['m.threadId'])
      .where('m.threadId IN (:...ids)', { ids: threadIds })
      .orderBy('m.threadId')
      .addOrderBy('m.createdAt', 'DESC')
      .getMany();
    for (const row of rows) map.set(row.threadId, row);
    return map;
  }
}
