import { Session } from "@shopify/shopify-api";
import { supabase } from "../supabase.server";
import { encrypt, decrypt } from "./crypto.server";

// Shape of a row in the `sessions` table (snake_case DB columns).
interface SessionRow {
  id: string;
  shop: string;
  state: string;
  is_online: boolean;
  scope: string | null;
  expires: string | null;
  access_token: string;
  user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  account_owner: boolean;
  locale: string | null;
  collaborator: boolean | null;
  email_verified: boolean | null;
  refresh_token: string | null;
  refresh_token_expires: string | null;
}

/**
 * Custom Supabase implementation of the Shopify SessionStorage interface.
 *
 * Implements the 5 methods required by @shopify/shopify-app-session-storage:
 *   storeSession, loadSession, deleteSession, deleteSessions, findSessionsByShop
 *
 * access_token and refresh_token are always stored AES-256-GCM encrypted.
 * The OAuth nonce (state field) is persisted by storeSession() BEFORE the
 * access token arrives, satisfying the library's CSRF protection mechanism.
 */
export class SupabaseSessionStorage {
  // ------------------------------------------------------------------
  // storeSession — UPSERT (handles both pre-auth state and post-auth token)
  // ------------------------------------------------------------------
  async storeSession(session: Session): Promise<boolean> {
    const row = this.toRow(session);
    const { error } = await supabase
      .from("sessions")
      .upsert(row, { onConflict: "id" });

    if (error) {
      console.error("[SessionStorage] storeSession error:", error.message);
      throw error;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // loadSession — SELECT by primary key
  // Uses maybeSingle() — returns null (not 406) when no row is found.
  // ------------------------------------------------------------------
  async loadSession(id: string): Promise<Session | undefined> {
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[SessionStorage] loadSession error:", error.message);
      throw error;
    }
    if (!data) return undefined;
    return this.fromRow(data as SessionRow);
  }

  // ------------------------------------------------------------------
  // deleteSession — DELETE by primary key (idempotent)
  // ------------------------------------------------------------------
  async deleteSession(id: string): Promise<boolean> {
    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[SessionStorage] deleteSession error:", error.message);
    }
    return true; // Mirror Prisma behaviour: true even if row didn't exist
  }

  // ------------------------------------------------------------------
  // deleteSessions — DELETE multiple by primary keys
  // ------------------------------------------------------------------
  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const { error } = await supabase
      .from("sessions")
      .delete()
      .in("id", ids);

    if (error) {
      console.error("[SessionStorage] deleteSessions error:", error.message);
      throw error;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // findSessionsByShop — SELECT by shop, ordered by expiry desc, limit 25
  // Mirrors PrismaSessionStorage: take 25, order expires desc.
  // ------------------------------------------------------------------
  async findSessionsByShop(shop: string): Promise<Session[]> {
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("shop", shop)
      .order("expires", { ascending: false, nullsFirst: false })
      .limit(25);

    if (error) {
      console.error("[SessionStorage] findSessionsByShop error:", error.message);
      throw error;
    }
    if (!data || data.length === 0) return [];
    return (data as SessionRow[]).map((row) => this.fromRow(row));
  }

  // ------------------------------------------------------------------
  // Private: Session → DB row
  // ------------------------------------------------------------------
  private toRow(session: Session): SessionRow {
    const params = session.toObject();
    // onlineAccessInfo.associated_user holds user fields for online sessions.
    const user = params.onlineAccessInfo?.associated_user as
      | {
          id: number;
          first_name: string;
          last_name: string;
          email: string;
          account_owner: boolean;
          locale: string;
          collaborator: boolean;
          email_verified: boolean;
        }
      | undefined;

    return {
      id: session.id,
      shop: session.shop,
      state: session.state,
      is_online: session.isOnline,
      scope: session.scope ?? null,
      expires: session.expires ? session.expires.toISOString() : null,
      // Encrypt tokens — never store plaintext access/refresh tokens at rest.
      access_token: session.accessToken ? encrypt(session.accessToken) : "",
      refresh_token: params.refreshToken
        ? encrypt(params.refreshToken as string)
        : null,
      refresh_token_expires: params.refreshTokenExpires
        ? new Date(params.refreshTokenExpires as unknown as number).toISOString()
        : null,
      // Online session user fields (null for offline sessions).
      user_id: user?.id ?? null,
      first_name: user?.first_name ?? null,
      last_name: user?.last_name ?? null,
      email: user?.email ?? null,
      account_owner: user?.account_owner ?? false,
      locale: user?.locale ?? null,
      collaborator: user?.collaborator ?? false,
      email_verified: user?.email_verified ?? false,
    };
  }

  // ------------------------------------------------------------------
  // Private: DB row → Session
  // Uses Session.fromPropertyArray() — the canonical factory method.
  // returnUserData=true reconstructs onlineAccessInfo from flattened fields.
  // ------------------------------------------------------------------
  private fromRow(row: SessionRow): Session {
    const params: [string, string | number | boolean][] = [
      ["id", row.id],
      ["shop", row.shop],
      ["state", row.state],
      ["isOnline", row.is_online],
    ];

    if (row.scope !== null) params.push(["scope", row.scope]);
    if (row.expires !== null) {
      params.push(["expires", new Date(row.expires).getTime()]);
    }

    // Decrypt access token — failures are caught so the session is treated
    // as inactive (triggers re-auth) rather than throwing a 500.
    if (row.access_token) {
      try {
        params.push(["accessToken", decrypt(row.access_token)]);
      } catch (e) {
        console.error("[SessionStorage] Failed to decrypt access_token:", e);
      }
    }

    if (row.refresh_token) {
      try {
        params.push(["refreshToken", decrypt(row.refresh_token)]);
      } catch (e) {
        console.error("[SessionStorage] Failed to decrypt refresh_token:", e);
      }
    }

    if (row.refresh_token_expires !== null) {
      params.push([
        "refreshTokenExpires",
        new Date(row.refresh_token_expires).getTime(),
      ]);
    }

    // Online session user fields — fromPropertyArray with returnUserData=true
    // rebuilds onlineAccessInfo from these flattened values.
    if (row.user_id !== null) params.push(["userId", String(row.user_id)]);
    if (row.first_name !== null) params.push(["firstName", row.first_name]);
    if (row.last_name !== null) params.push(["lastName", row.last_name]);
    if (row.email !== null) params.push(["email", row.email]);
    if (row.account_owner !== null)
      params.push(["accountOwner", row.account_owner]);
    if (row.locale !== null) params.push(["locale", row.locale]);
    if (row.collaborator !== null)
      params.push(["collaborator", row.collaborator]);
    if (row.email_verified !== null)
      params.push(["emailVerified", row.email_verified]);

    return Session.fromPropertyArray(params, true);
  }
}
