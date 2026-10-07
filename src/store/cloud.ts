import { create } from "zustand";
import { persist } from "zustand/middleware";
import { configApi } from "@/lib/config-api";

/**
 * Cloud / Tenant store — tracks the current user's cloud tenant state.
 * Used in cloud mode to manage the user's subdomain, backend status, and JWT.
 */

export type TenantStatus = "none" | "provisioning" | "active" | "suspended" | "error";

interface CloudStore {
  /** Whether we're running in cloud mode */
  isCloudMode: boolean;
  /** The user's subdomain (e.g. "raj") */
  subdomain: string | null;
  /** Tenant provisioning status */
  tenantStatus: TenantStatus;
  /** JWT auth token from Go auth service */
  jwtToken: string | null;
  /** Tenant ID (UUID) */
  tenantId: string | null;

  /** Initialize cloud mode from env + stored JWT */
  initCloudMode: () => void;
  /** Set JWT and extract claims */
  setJWT: (token: string | null) => void;
  /** Update tenant status */
  setTenantStatus: (status: TenantStatus) => void;
  /** Set subdomain */
  setSubdomain: (subdomain: string | null) => void;
  /** Clear all cloud state (logout) */
  clearCloud: () => void;
}

/** Decode JWT payload without verification (for client-side claim extraction) */
function decodeJWTPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export const useCloudStore = create<CloudStore>()(
  persist(
    (set) => ({
      isCloudMode: false,
      subdomain: null,
      tenantStatus: "none",
      jwtToken: null,
      tenantId: null,

      initCloudMode: () => {
        const cloudMode =
          typeof window !== "undefined" &&
          (process.env.NEXT_PUBLIC_CLOUD_MODE === "true" ||
            window.location.hostname.endsWith("mawadao.com"));

        if (cloudMode) {
          configApi.setCloudMode(true);
        }
        set({ isCloudMode: cloudMode });
      },

      setJWT: (token) => {
        if (!token) {
          configApi.setAuthToken(null);
          set({ jwtToken: null, subdomain: null, tenantId: null, tenantStatus: "none" });
          return;
        }

        const claims = decodeJWTPayload(token);
        const subdomain = (claims?.subdomain as string) || null;
        const tenantId = (claims?.tenantId as string) || null;

        configApi.setAuthToken(token);
        set({
          jwtToken: token,
          subdomain,
          tenantId,
          tenantStatus: subdomain ? "active" : "none",
        });
      },

      setTenantStatus: (status) => set({ tenantStatus: status }),
      setSubdomain: (subdomain) => set({ subdomain }),
      clearCloud: () => {
        configApi.setAuthToken(null);
        configApi.setCloudMode(false);
        set({
          isCloudMode: false,
          subdomain: null,
          tenantStatus: "none",
          jwtToken: null,
          tenantId: null,
        });
      },
    }),
    {
      name: "mawadao-cloud",
      partialize: (state) => ({
        jwtToken: state.jwtToken,
        subdomain: state.subdomain,
        tenantId: state.tenantId,
      }),
    }
  )
);
