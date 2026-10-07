import { useMemo, useState } from 'react';
import {
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type Updater,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { MCAgent, MCBoard } from '@/lib/mission-control/types';
import { DataTable, type DataTableEmptyState } from '@/components/mc/tables/DataTable';
import { dateCell, linkifyCell, pillCell } from '@/components/mc/tables/cell-formatters';
import { truncateText as truncate } from '@/lib/mc-formatters';
import type { ReactNode } from 'react';

type AgentsTableProps = {
  agents: MCAgent[];
  boards?: MCBoard[];
  isLoading?: boolean;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  showActions?: boolean;
  stickyHeader?: boolean;
  emptyMessage?: string;
  emptyState?: { title: string; description: string; icon?: ReactNode; actionHref?: string; actionLabel?: string };
  onDelete?: (agent: MCAgent) => void;
};

const DEFAULT_EMPTY_ICON = (
  <svg
    className="h-16 w-16 text-slate-300"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export function AgentsTable({
  agents,
  boards = [],
  isLoading = false,
  sorting,
  onSortingChange,
  showActions = true,
  stickyHeader = false,
  emptyMessage = 'No agents found.',
  emptyState,
  onDelete,
}: AgentsTableProps) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const resolvedSorting = sorting ?? internalSorting;
  const handleSortingChange: OnChangeFn<SortingState> =
    onSortingChange ?? ((updater: Updater<SortingState>) => setInternalSorting(updater));

  const boardNameById = useMemo(
    () => new Map(boards.map((board) => [board.id, board.name])),
    [boards]
  );

  const columns = useMemo<ColumnDef<MCAgent>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        cell: ({ row }) =>
          linkifyCell({
            href: `/mission-control/agents/${row.original.agent_id ?? row.original.id}`,
            label: row.original.name,
            subtitle: row.original.category ?? row.original.slug,
          }),
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ row }) => (
          <span className="text-xs text-slate-500">{row.original.category ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'verified',
        header: 'Status',
        cell: ({ row }) => pillCell(row.original.verified ? 'verified' : row.original.is_active ? 'active' : 'inactive'),
      },
      {
        accessorKey: 'installed_at',
        header: 'Installed',
        cell: ({ row }) => dateCell(row.original.installed_at),
      },
    ],
    [boardNameById]
  );

  const table = useReactTable({
    data: agents,
    columns,
    state: { sorting: resolvedSorting },
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      emptyMessage={emptyMessage}
      stickyHeader={stickyHeader}
      rowActions={
        showActions
          ? {
              getEditHref: (agent) => `/mission-control/agents/${agent.id}`,
              onDelete,
            }
          : undefined
      }
      rowClassName="hover:bg-slate-50"
      cellClassName="px-6 py-4"
      emptyState={
        emptyState
          ? {
              icon: emptyState.icon ?? DEFAULT_EMPTY_ICON,
              title: emptyState.title,
              description: emptyState.description,
              actionHref: emptyState.actionHref,
              actionLabel: emptyState.actionLabel,
            }
          : undefined
      }
    />
  );
}
