import { getUserProfile, updateProfile, listMembers, audit, type Logger } from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";

/**
 * Member profile. A member may edit only their own profile. The role, suspension state
 * and account ownership are never editable here; those live in the owner routes.
 */
export function registerProfileRoutes(router: Router, log: Logger): void {
  router.get("/api/profile", ({ res, userId }: RequestContext) => {
    void (async () => {
      const profile = await getUserProfile(userId!);
      if (!profile) {
        error(res, 404, "Profile not found.");
        return;
      }
      json(res, 200, {
        profile: {
          id: profile.id,
          username: profile.username,
          displayName: profile.displayName,
          role: profile.role,
          avatarSeed: profile.avatarSeed,
          bio: profile.bio,
          createdAt: profile.createdAt,
        },
      });
    })();
  });

  router.put("/api/profile", ({ res, body, userId, ip }: RequestContext) => {
    void (async () => {
      const { displayName, bio, avatarSeed } = (body ?? {}) as {
        displayName?: string | null;
        bio?: string | null;
        avatarSeed?: string | null;
      };
      const clean = (v: string | null | undefined, max: number): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const t = String(v).trim();
        if (t.length === 0) return null;
        return t.slice(0, max);
      };
      await updateProfile(userId!, {
        displayName: clean(displayName, 60) ?? null,
        bio: clean(bio, 280) ?? null,
        avatarSeed: clean(avatarSeed, 40) ?? null,
      });
      await audit({ actor: userId!, action: "profile.update", ip });
      log.info("profile updated", { userId });
      json(res, 200, { ok: true });
    })();
  });

  // A public member directory for the community. Never exposes private data.
  router.get("/api/profile/directory", ({ res }: RequestContext) => {
    void (async () => {
      const members = await listMembers(200);
      json(res, 200, {
        members: members.map((m) => ({
          id: m.id,
          username: m.username,
          displayName: m.displayName,
          role: m.role,
          avatarSeed: m.avatarSeed,
          bio: m.bio,
          suspended: Boolean(m.suspendedAt),
        })),
      });
    })();
  });
}
