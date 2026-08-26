import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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

  async getOrCreateMine(userId: string, roles: string[]) {
    const userRole = roles.includes(UserRole.DRIVER) ? 'driver' : 'rider';
    let thread = await this.threads.findOne({
      where: { userId, status: SupportThreadStatus.OPEN },
      order: { lastMessageAt: 'DESC' },
    });
    if (!thread) {
      const now = new Date();
      thread = await this.threads.save(
        this.threads.create({
          userId,
          userRole,
          status: SupportThreadStatus.OPEN,
          assignedAgentId: null,
          lastMessageAt: now,
        }),
      );
      await this.messages.save(
        this.messages.create({
          threadId: thread.id,
          senderId: userId,
          senderRole: SupportSenderRole.SYSTEM,
          senderName: 'ህብር Support',
          body: 'A support agent will reply here. This conversation is saved so any agent can pick it up.',
        }),
      );
    }
    return this.threadPayload(thread);
  }

  async postUserMessage(userId: string, roles: string[], body: string) {
    const { thread } = await this.getOrCreateMine(userId, roles);
    const user = await this.users.findOne({ where: { id: userId } });
    return this.appendMessage({
      threadId: thread.id,
      senderId: userId,
      senderRole: SupportSenderRole.USER,
      senderName: user?.fullName || user?.phoneNumber || 'Customer',
      body,
      notifyUserId: null,
    });
  }

  async listThreads(status?: string) {
    const where =
      status === 'open' || status === 'closed'
        ? { status: status as SupportThreadStatus }
        : {};
    const rows = await this.threads.find({
      where,
      order: { lastMessageAt: 'DESC' },
      take: 100,
    });
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

  async getThreadForStaff(threadId: string) {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Support thread not found');
    return this.threadPayload(thread);
  }

  async postAgentMessage(threadId: string, agentId: string, body: string) {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Support thread not found');
    const agent = await this.users.findOne({ where: { id: agentId } });
    if (thread.status === SupportThreadStatus.CLOSED) {
      thread.status = SupportThreadStatus.OPEN;
    }
    if (!thread.assignedAgentId) {
      thread.assignedAgentId = agentId;
    }
    await this.threads.save(thread);
    return this.appendMessage({
      threadId,
      senderId: agentId,
      senderRole: SupportSenderRole.AGENT,
      senderName: agent?.fullName || agent?.phoneNumber || 'Support agent',
      body,
      notifyUserId: thread.userId,
    });
  }

  async updateThread(
    threadId: string,
    agentId: string,
    patch: { status?: 'open' | 'closed' },
  ) {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Support thread not found');
    if (patch.status) {
      thread.status = patch.status as SupportThreadStatus;
    }
    thread.assignedAgentId = agentId;
    await this.threads.save(thread);
    return this.threadPayload(thread);
  }

  private async appendMessage(input: {
    threadId: string;
    senderId: string;
    senderRole: SupportSenderRole;
    senderName: string;
    body: string;
    notifyUserId: string | null;
  }) {
    const trimmed = input.body.trim();
    if (!trimmed) throw new ForbiddenException('Message body is required');
    const message = await this.messages.save(
      this.messages.create({
        threadId: input.threadId,
        senderId: input.senderId,
        senderRole: input.senderRole,
        senderName: input.senderName.slice(0, 120),
        body: trimmed.slice(0, 2000),
      }),
    );
    await this.threads.update(input.threadId, {
      lastMessageAt: message.createdAt,
    });
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

  private async threadPayload(thread: SupportThread) {
    const user = await this.users.findOne({ where: { id: thread.userId } });
    const messages = await this.messages.find({
      where: { threadId: thread.id },
      order: { createdAt: 'ASC' },
      take: 500,
    });
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
    };
  }

  private mapMessage(message: SupportMessage) {
    return {
      id: message.id,
      threadId: message.threadId,
      senderId: message.senderId,
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
