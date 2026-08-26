import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase/firebase.service';
import { OtpService } from './otp.service';
import {
  AccountStanding,
  UserAccount,
  UserRole,
} from './entities/user-account.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { REDIS_CLIENT } from '../../redis/redis.module';

describe('FirebaseAuthSecuritySpec', () => {
  let authService: AuthService;
  let firebaseService: FirebaseService;

  const mockUsers: Map<string, UserAccount> = new Map();

  const mockUsersRepository = {
    findOne: jest.fn(async ({ where }) => {
      const conditions = Array.isArray(where) ? where : [where];
      for (const cond of conditions) {
        for (const user of mockUsers.values()) {
          if (cond.firebaseUid && user.firebaseUid === cond.firebaseUid) {
            return { ...user };
          }
          if (cond.phoneNumber && user.phoneNumber === cond.phoneNumber) {
            return { ...user };
          }
          if (cond.id && user.id === cond.id) {
            return { ...user };
          }
        }
      }
      return null;
    }),
    save: jest.fn(async (entity) => {
      const id = entity.id || `user-id-${Date.now()}-${Math.random()}`;
      const saved = { ...entity, id };
      mockUsers.set(id, saved);
      return saved;
    }),
    create: jest.fn((dto) => dto),
  };

  const mockRefreshTokensRepository = {
    save: jest.fn(async (t) => t),
    create: jest.fn((dto) => dto),
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(() => 'mock.hebir.jwt.token'),
    signAsync: jest.fn(async () => 'mock.hebir.jwt.token'),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_ACCESS_EXPIRES_IN') return '15m';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '30d';
      return null;
    }),
  };

  const mockRedis = {
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
  };

  const mockOtpService = {
    consumeCode: jest.fn(async () => true),
    consumeSession: jest.fn(async () => true),
  };

  beforeEach(async () => {
    mockUsers.clear();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        FirebaseService,
        {
          provide: getRepositoryToken(UserAccount),
          useValue: mockUsersRepository,
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: mockRefreshTokensRepository,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: OtpService,
          useValue: mockOtpService,
        },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    firebaseService = module.get<FirebaseService>(FirebaseService);
  });

  describe('Security Guard 1: Fake & Malformed Token Rejection', () => {
    it('rejects empty or non-string tokens with 401 Unauthorized', async () => {
      await expect(
        authService.loginWithFirebase({ firebaseIdToken: '' }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        authService.loginWithFirebase({ firebaseIdToken: null as any }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects invalid/unverified tokens in non-dev format', async () => {
      // Unrecognized tokens that are not valid JWTs will be rejected by Firebase verifyIdToken
      await expect(
        authService.loginWithFirebase({
          firebaseIdToken: 'fake.malformed.idtoken123',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Security Guard 2: New Rider & Driver User Creation', () => {
    it('creates a new rider account when valid test token is provided', async () => {
      const result = await authService.loginWithFirebase({
        firebaseIdToken: 'test-token:+251911112233:fb-uid-rider-1',
        fullName: 'Abebe Bikila',
        roles: [UserRole.RIDER],
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.phoneNumber).toBe('+251911112233');
      expect(result.user.roles).toContain(UserRole.RIDER);
    });

    it('prevents privilege escalation by stripping admin roles during signup', async () => {
      const result = await authService.loginWithFirebase({
        firebaseIdToken: 'test-token:+251922334455:fb-uid-attacker',
        fullName: 'Sneaky Attacker',
        roles: [UserRole.ADMIN, UserRole.GOV_OFFICER, UserRole.DRIVER],
      });

      // Only self-service roles (DRIVER) should survive, ADMIN and GOV_OFFICER are filtered
      expect(result.user.roles).not.toContain(UserRole.ADMIN);
      expect(result.user.roles).not.toContain(UserRole.GOV_OFFICER);
      expect(result.user.roles).toContain(UserRole.DRIVER);
    });
  });

  describe('Security Guard 3: Safe Existing User Linking', () => {
    it('links an existing database user by phone number without creating duplicates', async () => {
      // Seed existing user without firebaseUid
      const existingUser: UserAccount = {
        id: 'user-uuid-existing-1',
        phoneNumber: '+251933445566',
        fullName: 'Existing Driver',
        firebaseUid: null,
        phoneVerifiedAt: null,
        roles: [UserRole.DRIVER],
        standing: AccountStanding.GOOD,
        username: null,
        tin: null,
        passwordHash: null,
        savedPlaces: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsers.set(existingUser.id, existingUser);

      const result = await authService.loginWithFirebase({
        firebaseIdToken: 'test-token:0933445566:fb-uid-newly-linked',
      });

      expect(result.user.id).toBe('user-uuid-existing-1');
      expect(result.user.phoneNumber).toBe('+251933445566');

      // Verify that mockUsers has not added a second user
      expect(mockUsers.size).toBe(1);
      const updated = mockUsers.get('user-uuid-existing-1');
      expect(updated?.firebaseUid).toBe('fb-uid-newly-linked');
      expect(updated?.phoneVerifiedAt).toBeDefined();
    });
  });

  describe('Security Guard 4: Banned/Closed Account Rejection', () => {
    it('rejects banned user with 403 Forbidden even with valid Firebase OTP', async () => {
      const bannedUser: UserAccount = {
        id: 'user-uuid-banned',
        phoneNumber: '+251944556677',
        fullName: 'Banned Bad Actor',
        firebaseUid: 'fb-uid-banned',
        phoneVerifiedAt: new Date(),
        roles: [UserRole.RIDER],
        standing: AccountStanding.BANNED,
        username: null,
        tin: null,
        passwordHash: null,
        savedPlaces: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsers.set(bannedUser.id, bannedUser);

      await expect(
        authService.loginWithFirebase({
          firebaseIdToken: 'test-token:+251944556677:fb-uid-banned',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects deleted user with 403 Forbidden', async () => {
      const deletedUser: UserAccount = {
        id: 'user-uuid-deleted',
        phoneNumber: '+251955667788',
        fullName: 'Deleted Account',
        firebaseUid: 'fb-uid-deleted',
        phoneVerifiedAt: new Date(),
        roles: [UserRole.RIDER],
        standing: AccountStanding.DELETED,
        username: null,
        tin: null,
        passwordHash: null,
        savedPlaces: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsers.set(deletedUser.id, deletedUser);

      await expect(
        authService.loginWithFirebase({
          firebaseIdToken: 'test-token:+251955667788:fb-uid-deleted',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
