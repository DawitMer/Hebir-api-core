/**
 * Dev/local helper: request OTP (returns debugCode) and exchange for tokens.
 * Rider/driver accounts are passwordless — smoke/seed scripts must use this.
 */
import axios from 'axios';

export async function loginWithOtp(
  apiBase: string,
  phoneNumber: string,
  roles: Array<'rider' | 'driver'> = ['rider'],
  fullName?: string,
) {
  const { data: req } = await axios.post(`${apiBase}/auth/otp/request`, {
    phoneNumber,
  });
  const code = req.debugCode as string | undefined;
  if (!code) {
    throw new Error(
      'OTP request did not return debugCode (SMS-only production mode?)',
    );
  }
  const { data } = await axios.post(`${apiBase}/auth/otp/login`, {
    phoneNumber,
    code,
    roles,
    ...(fullName ? { fullName } : {}),
  });
  return data as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; phoneNumber: string; fullName?: string; roles: string[] };
  };
}
