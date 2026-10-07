import { Badge } from '@/components/mc/ui/badge';

const STATUS_STYLES: Record<
  string,
  'default' | 'outline' | 'accent' | 'success' | 'warning' | 'danger'
> = {
  inbox: 'outline',
  planned: 'accent',
  assigned: 'accent',
  in_progress: 'warning',
  testing: 'accent',
  review: 'accent',
  done: 'success',
  cancelled: 'outline',
  online: 'success',
  active: 'success',
  busy: 'warning',
  provisioning: 'warning',
  offline: 'outline',
  inactive: 'outline',
  deleting: 'danger',
  error: 'danger',
  updating: 'accent',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_STYLES[status] ?? 'default'}>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}
