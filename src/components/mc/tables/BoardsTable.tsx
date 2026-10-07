import { useMemo, useState } from 'react';
import {
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type Updater,
  type VisibilityState,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { MCBoard } from '@/lib/mission-control/types';
import { DataTable, type DataTableEmptyState } from '@/components/mc/tables/DataTable';
import { dateCell, linkifyCell } from '@/components/mc/tables/cell-formatters';

type BoardsTableProps = {
  boards: MCBoard[];
  isLoading?: boolean;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  stickyHeader?: boolean;
  showActions?: boolean;
  onDelete?: (board: MCBoard) => void;
  emptyMessage?: string;
  emptyState?: Omit<DataTableEmptyState, 'icon'> & { icon?: DataTableEmptyState['icon'] };
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
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </svg>
);

export function BoardsTable({
  boards,
  isLoading = false,
  sorting,
  onSortingChange,
  stickyHeader = false,
  showActions = true,
  onDelete,
  emptyMessage = 'No boards found.',
  emptyState,
}: BoardsTableProps) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const resolvedSorting = sorting ?? internalSorting;
  const handleSortingChange: OnChangeFn<SortingState> =
    onSortingChange ?? ((updater: Updater<SortingState>) => setInternalSorting(updater));

  const columns = useMemo<ColumnDef<MCBoard>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Board',
        cell: ({ row }) =>
          linkifyCell({
            href: `/mission-control/boards/${row.original.id}`,
            label: row.original.name,
          }),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <span className="text-sm text-slate-700 capitalize">{row.original.status}</span>
        ),
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ row }) => dateCell(row.original.updated_at),
      },
    ],
    []
  );

  const table = useReactTable({
    data: boards,
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
      stickyHeader={stickyHeader}
      emptyMessage={emptyMessage}
      rowClassName="transition hover:bg-slate-50"
      cellClassName="px-3 py-3 md:px-6 md:py-4 align-top"
      rowActions={
        showActions
          ? {
              getEditHref: (board) => `/mission-control/boards/${board.id}`,
              onDelete,
            }
          : undefined
      }
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
