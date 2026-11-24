'use client';
import { useQuery } from '@tanstack/react-query';
import { brain } from '@/lib/brain';

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
}

export function useSession() {
  return useQuery<SessionResponse, Error>({
    queryKey: ['session'],
    queryFn: () => brain<SessionResponse>('/api/auth/session'),
    refetchInterval: 60_000,
    retry: 2
  });
}

export interface ProjectHomes {
  cash: string | null;
  manufacturing: string | null;
  labor: string | null;
  puzzles: string | null;
  fallback: string | null;
}
