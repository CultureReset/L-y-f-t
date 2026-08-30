/**
 * Ops sign-in.
 *
 * The console needs an account whose session carries the admin role. Admin is
 * not self-serve — the API only issues it to a user who already holds the role,
 * so this screen surfaces that plainly rather than pretending otherwise.
 */

import React, { useState } from 'react';
import { ApiError, LiftClient } from '@lift/sdk';

export interface SignInProps {
  readonly apiUrl: string;
  readonly onSignedIn: (token: string) => void;
}

export const SignIn = ({ apiUrl, onSignedIn }: SignInProps): React.JSX.Element => {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const client = new LiftClient({ baseUrl: apiUrl });

  const requestCode = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.requestCode(phone);
      if (result.devCode) setCode(result.devCode);
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : `Could not reach ${apiUrl}`);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      // Asking for an admin session fails unless the account already holds the
      // role — the API refuses to grant operator access at sign-in.
      const session = await client.verifyCode({ phone, code, role: 'admin' });
      onSignedIn(session.token);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <h1>Operations</h1>
      <p>
        Sign in with an operator account. Connected to <code>{apiUrl}</code>.
      </p>

      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Phone number"
        aria-label="Phone number"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !sent) void requestCode();
        }}
      />

      {sent ? (
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Verification code"
          aria-label="Verification code"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void verify();
          }}
        />
      ) : null}

      <button
        onClick={() => void (sent ? verify() : requestCode())}
        disabled={busy || phone.replace(/\D/g, '').length < 10}
      >
        {sent ? 'Sign in' : 'Send code'}
      </button>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
};
