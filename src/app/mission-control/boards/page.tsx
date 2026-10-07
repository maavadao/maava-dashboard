'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import { BoardsTable } from '@/components/mc/tables/BoardsTable';
import { ConfirmActionDialog } from '@/components/mc/ui/confirm-action-dialog';
import { MCButton, buttonVariants } from '@/components/mc/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/mc/ui/dialog';
import { useMCBoards, useDeleteMCBoard, useCreateMCBoard, mcKeys } from '@/hooks/mc';
import type { MCBoard, MCBoardCreate } from '@/lib/mission-control/types';

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function BoardsPage() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<MCBoard | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [boardType, setBoardType] = useState<'standard' | 'kanban' | 'scrum'>('kanban');
  const [objective, setObjective] = useState('');

  const boardsQuery = useMCBoards({ limit: 200 });
  const boards = useMemo(() => boardsQuery.data?.items ?? [], [boardsQuery.data]);

  const deleteMutation = useDeleteMCBoard();
  const createMutation = useCreateMCBoard();

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        queryClient.invalidateQueries({ queryKey: mcKeys.boards() });
      },
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const data: MCBoardCreate = {
      name: name.trim(),
      slug: slugify(name),
      description: description.trim() || `Board: ${name.trim()}`,
      board_type: boardType,
      objective: objective.trim() || undefined,
    };
    createMutation.mutate(data, {
      onSuccess: () => {
        setShowCreate(false);
        setName('');
        setDescription('');
        setObjective('');
        setBoardType('kanban');
      },
    });
  };

  return (
    <>
      <DashboardPageLayout
        title="Boards"
        description={`Manage boards and task workflows. ${boards.length} board${boards.length === 1 ? '' : 's'} total.`}
        headerActions={
          <MCButton variant="primary" size="md" onClick={() => setShowCreate(true)}>
            Create board
          </MCButton>
        }
      >
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <BoardsTable
            boards={boards}
            isLoading={boardsQuery.isLoading}
            onDelete={setDeleteTarget}
          />
        </div>

        {boardsQuery.error ? (
          <p className="mt-4 text-sm text-red-500">
            {boardsQuery.error.message}
          </p>
        ) : null}
      </DashboardPageLayout>

      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        ariaLabel="Delete board"
        title="Delete board"
        description={
          <>This will remove {deleteTarget?.name}. This action cannot be undone.</>
        }
        errorMessage={deleteMutation.error?.message}
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />

      {/* Create Board Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Board</DialogTitle>
            <DialogDescription>
              Set up a new board to organize tasks and agents.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-2">
            <div>
              <label className="text-sm font-medium text-slate-700">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Marketing Sprint"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this board for?"
                rows={2}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-slate-700">Board Type</label>
                <select
                  value={boardType}
                  onChange={(e) => setBoardType(e.target.value as 'standard' | 'kanban' | 'scrum')}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="kanban">Kanban</option>
                  <option value="standard">Standard</option>
                  <option value="scrum">Scrum</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Objective</label>
                <input
                  type="text"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="Optional goal"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                />
              </div>
            </div>
            {createMutation.error && (
              <p className="text-sm text-red-500">{createMutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <MCButton
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </MCButton>
              <MCButton
                type="submit"
                variant="primary"
                size="md"
                disabled={!name.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Board'}
              </MCButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
