import {
  Alert,
  Button,
  Center,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = field(form, 'email');
    const password = field(form, 'password');
    setPending(true);
    setError(null);
    const result =
      mode === 'sign-in'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: field(form, 'name') });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? 'Something went wrong');
      return;
    }
    await navigate({ to: '/' });
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w="100%" maw={380}>
        <form onSubmit={onSubmit}>
          <Stack>
            <Title order={2}>PostHub</Title>
            <SegmentedControl
              value={mode}
              onChange={(value) => setMode(value as typeof mode)}
              data={[
                { label: 'Sign in', value: 'sign-in' },
                { label: 'Create account', value: 'sign-up' },
              ]}
            />
            {mode === 'sign-up' && <TextInput name="name" label="Name" required />}
            <TextInput name="email" type="email" label="Email" required />
            <PasswordInput name="password" label="Password" minLength={8} required />
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={pending}>
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
