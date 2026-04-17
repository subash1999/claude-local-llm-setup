import { useSSO } from '@clerk/expo';
import { useState } from 'react';
import { useClerk } from '@clerk/expo';
import { activateAndRegister } from './activate';

export function useGoogleAuth() {
  const clerk = useClerk();
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);
  const { startSSOFlow } = useSSO();

  async function signInWithGoogle() {
    setIsLoading(true);
    try {
      const redirectUrl = 'myapp://auth/callback';

      // kick off OAuth
      const { createdSessionId } = await startSSOFlow({ strategy: 'oauth_google', redirectUrl });

      // if user cancelled the flow, return early
      // and let caller navigate
      if (createdSessionId) {
        await activateAndRegister(clerk, createdSessionId);
      }
    } catch (error) {
      if (error.message.includes('cancel')) return;
      setLastError(error as Error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }

  return { signInWithGoogle, isLoading, lastError };
}
