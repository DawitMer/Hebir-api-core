import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export interface VerifiedFirebaseToken {
  uid: string;
  phoneNumber: string;
  phoneVerified: boolean;
  email?: string;
  rawPayload?: Record<string, unknown>;
}

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private firebaseAdmin: any = null;
  private firebaseApp: any = null;
  private initialized = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    try {
      // Use CommonJS require to maintain maximum compatibility across Node.js & Jest
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.firebaseAdmin = require('firebase-admin');
    } catch {
      this.logger.warn('firebase-admin package not loaded in this environment');
      return;
    }

    if (this.firebaseAdmin.apps && this.firebaseAdmin.apps.length > 0) {
      this.firebaseApp = this.firebaseAdmin.apps[0];
      this.initialized = true;
      this.logger.log('Using existing Firebase Admin app initialization');
      return;
    }

    const projectId =
      this.config.get<string>('FIREBASE_PROJECT_ID') ||
      process.env.FIREBASE_PROJECT_ID ||
      'hebir-ride';

    const emulatorHost =
      this.config.get<string>('FIREBASE_AUTH_EMULATOR_HOST') ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST;

    if (emulatorHost) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorHost;
      this.logger.log(
        `Firebase Auth Emulator configured at: ${emulatorHost}`,
      );
    }

    const saPath =
      this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS') ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.resolve(__dirname, '../../../../secrets/firebase-adminsdk.json');

    const saInline =
      this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON') ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    try {
      if (saInline) {
        const credentials = JSON.parse(saInline);
        this.firebaseApp = this.firebaseAdmin.initializeApp({
          credential: this.firebaseAdmin.credential.cert(credentials),
          projectId: credentials.project_id || projectId,
        });
        this.initialized = true;
        this.logger.log(
          `Firebase Admin initialized via inline JSON for project: ${projectId}`,
        );
      } else if (fs.existsSync(saPath)) {
        const credentials = JSON.parse(fs.readFileSync(saPath, 'utf8'));
        this.firebaseApp = this.firebaseAdmin.initializeApp({
          credential: this.firebaseAdmin.credential.cert(credentials),
          projectId: credentials.project_id || projectId,
        });
        this.initialized = true;
        this.logger.log(
          `Firebase Admin initialized via credentials file (${saPath}) for project: ${projectId}`,
        );
      } else {
        this.firebaseApp = this.firebaseAdmin.initializeApp({
          projectId,
        });
        this.initialized = true;
        this.logger.log(
          `Firebase Admin initialized with default projectId: ${projectId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Firebase Admin initialization notice: ${(error as Error).message}. Dev mock fallback active.`,
      );
    }
  }

  /**
   * Cryptographically verifies a Firebase ID token.
   *
   * Handles production tokens, emulator tokens, and test suite mock tokens.
   */
  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedException('Missing or invalid Firebase ID token');
    }

    // Test / Dev-mode deterministic tokens (e.g. test-token:+251911223344 or mock-firebase:phone:uid)
    if (
      process.env.NODE_ENV !== 'production' &&
      (idToken.startsWith('test-token:') || idToken.startsWith('mock-firebase:'))
    ) {
      const parts = idToken.split(':');
      const phoneNumber = parts[1] || '+251911000001';
      const uid =
        parts[2] ||
        `test-uid-${Buffer.from(phoneNumber).toString('hex').slice(0, 16)}`;
      return {
        uid,
        phoneNumber,
        phoneVerified: true,
      };
    }

    if (!this.initialized || !this.firebaseApp) {
      throw new UnauthorizedException(
        'Firebase authentication service is temporarily unavailable',
      );
    }

    try {
      const decoded = await this.firebaseAdmin
        .auth(this.firebaseApp)
        .verifyIdToken(idToken, true);

      if (!decoded.phone_number) {
        throw new UnauthorizedException(
          'Firebase ID token does not contain a verified phone number',
        );
      }

      return {
        uid: decoded.uid,
        phoneNumber: decoded.phone_number,
        phoneVerified: true,
        email: decoded.email,
        rawPayload: decoded,
      };
    } catch (error) {
      const err = error as { code?: string; message?: string };
      this.logger.warn(`Firebase token verification failed: ${err.message}`);

      if (err.code === 'auth/id-token-expired') {
        throw new UnauthorizedException(
          'Authentication token has expired. Please verify your phone number again.',
        );
      }
      if (err.code === 'auth/id-token-revoked') {
        throw new UnauthorizedException(
          'Authentication token has been revoked.',
        );
      }
      if (err.code === 'auth/invalid-id-token') {
        throw new UnauthorizedException('Invalid authentication token.');
      }

      throw new UnauthorizedException(
        'Unable to authenticate with Firebase token.',
      );
    }
  }
}
