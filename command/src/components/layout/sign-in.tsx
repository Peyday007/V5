'use client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BrainError, post } from '@/lib/brain';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * Brain's own sign-in door (identity + PIN at `/api/auth/pin`, or email + password at `/api/auth/login`), the same one the
 * console uses. No second account system: the session cookie it sets is the
 * session every /api route already checks.
 */
export default function SignIn({ error }: { error: string | null }) {
  const client = useQueryClient();
  const [identity, setIdentity] = useState('');
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState<'pin' | 'password'>('pin');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'pin') await post('/api/auth/pin', { identity: identity.trim(), pin });
      else await post('/api/auth/login', { email: identity.trim(), password: pin });
      await client.invalidateQueries();
    } catch (e) {
      setMessage(e instanceof BrainError ? e.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className='bg-muted/30 flex min-h-dvh items-center justify-center p-4'>
      <Card className='w-full max-w-sm'>
        <CardHeader>
          <div className='bg-primary text-primary-foreground mb-2 flex size-9 items-center justify-center rounded-lg text-sm font-semibold'>
            B
          </div>
          <CardTitle>Sign in to Brain</CardTitle>
          <CardDescription>The command center uses your Brain account.</CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className='flex flex-col gap-4'>
            <div className='flex flex-col gap-2'>
              <Label htmlFor='identity'>Email or name</Label>
              <Input
                id='identity'
                autoComplete='username'
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                required
              />
            </div>
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between'>
                <Label htmlFor='pin'>{mode === 'pin' ? 'PIN' : 'Password'}</Label>
                <button
                  type='button'
                  className='text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline'
                  onClick={() => setMode(mode === 'pin' ? 'password' : 'pin')}
                >
                  {mode === 'pin' ? 'Use a password' : 'Use a PIN'}
                </button>
              </div>
              <Input
                id='pin'
                type='password'
                inputMode={mode === 'pin' ? 'numeric' : 'text'}
                autoComplete='current-password'
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required
              />
            </div>
            {(message || (error && !message)) && (
              <p className='text-destructive text-sm' role='alert'>
                {message ?? error}
              </p>
            )}
          </CardContent>
          <CardFooter className='mt-4 flex flex-col items-stretch gap-2'>
            <Button type='submit' disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <Button variant='ghost' render={<a href='/' />}>
              Use a passkey in Brain
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
