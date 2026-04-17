import { useSignIn } from '@clerk/expo';
import { useState } from 'react';

export function useEmailSignIn() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { fetchStatus } = signIn ?? {};
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  const isLoading = fetchStatus === 'fetching';

  async function sendCode() {
    setPending(true);
    const result = await signIn?.create({ identifier: email });
    if (result.error) throw result.error;

    await signIn.emailCode.sendCode();
    if (result.error) throw result.error;
  }

  async function resendCode() {
    if (!signIn) return;
    setPending(true);
    const result = await signIn.emailCode.sendCode();
    if (result.error) throw result.error;
  }

  async function verifyCode(code: string) {
    setPending(true);
    const result = await signIn.emailCode.verifyCode({ code });
    if (result.error) throw result.error;
    await setActive({ session: result.createdSessionId });
  }

  return { sendCode, resendCode, verifyCode, isLoading, isLoaded };
}
