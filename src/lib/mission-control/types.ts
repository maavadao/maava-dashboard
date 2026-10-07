// Mission Control TypeScript types — mirrors the MC backend schemas

export interface MCBoard {
  id: string;
  organization_id: string;
  board_group_id: string | null;
  name: string;
  slug: string;
  board_type: 'standard' | 'kanban' | 'scrum';
  objective: string | null;
  target_date: string | null;
  status: 'active' | 'archived' | 'paused';
  autonomy_enabled: boolean;
  created_at: string;
  updated_at: string;
  task_count?: number;
  agent_count?: number;
}

export interface MCBoardCreate {
  name: string;
  slug: string;
  description: string;
  gateway_id?: string;
  board_type?: 'standard' | 'kanban' | 'scrum';
  objective?: string;
  target_date?: string;
  board_group_id?: string;
}

export interface MCTask {
  id: string;
  board_id: string;
  title: string;
  description: string | null;
  status: MCTaskStatus;
  priority: MCTaskPriority;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  due_at: string | null;
  completed_at: string | null;
  blocked: boolean;
  blocked_reason: string | null;
  tags: MCTag[];
  comments_count: number;
  dependencies: string[];
  created_at: string;
  updated_at: string;
}

export type MCTaskStatus = 'inbox' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type MCTaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface MCTaskCreate {
  title: string;
  description?: string;
  status?: MCTaskStatus;
  priority?: MCTaskPriority;
  assigned_agent_id?: string;
  due_at?: string;
  tags?: string[];
}

export interface MCTaskUpdate {
  title?: string;
  description?: string;
  status?: MCTaskStatus;
  priority?: MCTaskPriority;
  assigned_agent_id?: string | null;
  due_at?: string | null;
  blocked?: boolean;
  blocked_reason?: string | null;
}

export interface MCTaskComment {
  id: string;
  task_id: string;
  author_type: 'user' | 'agent';
  author_name: string;
  content: string;
  created_at: string;
}

export interface MCAgent {
  id: string;
  install_id: string;
  agent_id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  category: string | null;
  developer: string | null;
  icon_url: string | null;
  verified: boolean;
  is_active: boolean;
  installed_at: string;
  last_used_at: string | null;
  model: string | null;
  // MC backend fields (populated when sourced from MC backend)
  board_id?: string | null;
  gateway_id?: string | null;
  mc_status?: string | null;       // "provisioning" | "active" | "paused" | "retired"
  is_board_lead?: boolean;
  is_gateway_main?: boolean;
  last_seen_at?: string | null;
  source?: 'mc_backend' | 'local_db';
}

export interface MCApproval {
  id: string;
  board_id: string;
  board_name: string;
  task_id: string | null;
  task_title: string | null;
  requested_by: string;
  requested_by_name: string;
  status: 'pending' | 'approved' | 'rejected';
  confidence: number | null;
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MCActivityEvent {
  id: string;
  board_id: string | null;
  board_name: string | null;
  user_id: string | null;
  agent_id: string | null;
  actor_name: string | null;
  event_type: string;
  message: string | null;
  route_name: string | null;
  route_params: Record<string, string> | null;
  created_at: string;
}

export interface MCTag {
  id: string;
  name: string;
  color: string;
}

// Paginated response envelope
export interface MCPaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface MCUser {
  id: string;
  email: string;
  name: string;
  preferred_name: string;
  is_super_admin: boolean;
}

// ── Unified Approval ────────────────────────────────────────────────────────
// Merges MC approvals and seller approval_requests into one UI-consumable shape.

export interface UnifiedApproval {
  source: 'mc' | 'seller';
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  // MC-specific
  board_id?: string;
  board_name?: string;
  task_id?: string;
  task_title?: string;
  confidence?: number | null;
  requested_by_name?: string;
  // Seller-specific
  product_id?: string;
  product_name?: string;
  request_type?: 'listing' | 'publish' | 'visual' | 'promotion';
}
