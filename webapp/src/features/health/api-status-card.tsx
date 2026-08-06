import { Button } from '@base-ui/react/button';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { Card } from '@/components/ui/card';
import { fetchHealth } from '@/lib/health';
import { ru } from '@/locales/ru';

type HealthQueryOptions = Pick<UseQueryOptions, 'retry' | 'retryDelay'>;

export function useHealth(options: HealthQueryOptions = {}) {
  return useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2_000),
    ...options,
  });
}

export function ApiStatusCard({ queryOptions }: { queryOptions?: HealthQueryOptions }) {
  const query = useHealth(queryOptions);

  if (query.isPending) {
    return (
      <Card aria-live="polite">
        <h2 className="text-lg font-semibold">{ru.health.title}</h2>
        <p className="mt-2 text-muted-foreground">{ru.health.loading}</p>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card aria-live="assertive">
        <h2 className="text-lg font-semibold">{ru.health.title}</h2>
        <p className="mt-2 text-destructive">{query.error.message}</p>
        <Button className="button-primary mt-4" onClick={() => void query.refetch()}>
          {ru.health.retry}
        </Button>
      </Card>
    );
  }

  return (
    <Card aria-live="polite">
      <h2 className="text-lg font-semibold">{ru.health.title}</h2>
      <p className="mt-2 text-emerald-700">{ru.health.ready}</p>
      <p className="mt-1 text-sm text-muted-foreground">{query.data.service}</p>
    </Card>
  );
}
