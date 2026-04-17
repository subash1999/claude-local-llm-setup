import { useSignUp } from '@clerk/expo';
import { useState } from 'react';

export function useEmailSignUp() {
  const { signUp, setActive, isLoaded } = useSignUp();
  const { fetchStatus } = signUp ?? {};
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  const isLoading = fetchStatus === 'fetching';

  async function sendCode() {
    setPending(true);
    const result = await signUp?.create({ emailAddress: email, password });
    if (result.error) throw result.error;

    await signUp.verifications.sendEmailCode();
    if (result.error) throw result.error;
  }

  async function resendCode() {
    if (!signUp) return;
    setPending(true);
    const result = await signUp.verifications.sendEmailCode();
    if (result.error) throw result.error;
  }

  async function verifyCode(code: string) {
    setPending(true);
    const result = await signUp.verifications.verifyEmailCode({ code });
    if (result.error) throw result.error;
    await setActive({ session: result.createdSessionId });
  }

  return { sendCode, resendCode, verifyCode, isLoading, isLoaded };
}
