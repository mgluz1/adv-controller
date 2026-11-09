/**
 * Papéis e permissões de um escritório. Fonte única: o plugin de organização do Better Auth usa
 * `ac` + `roles` para os endpoints /api/auth/organization/*, e `can()` aplica as MESMAS regras às
 * operações de domínio (/api/v1/*).
 *
 * Papéis (por escritório; um usuário pode ter papéis diferentes em escritórios diferentes):
 *  - owner  : tudo, inclusive excluir o escritório e promover donos.
 *  - admin  : gerencia membros, convites, OABs e coleta; não exclui o escritório nem mexe em donos.
 *  - member : opera as publicações (revisar, arquivar, restaurar); só lê as OABs.
 *  - viewer : somente leitura.
 */
import { createAccessControl } from "better-auth/plugins/access";

export const statements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  attorney: ["read", "create", "update"],
  publication: ["read", "review", "archive", "restore", "discard"],
  sync: ["read", "request"],
  audit: ["read"],
} as const;

export type Resource = keyof typeof statements;
export type Action<R extends Resource> = (typeof statements)[R][number];

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    attorney: ["read", "create", "update"],
    publication: ["read", "review", "archive", "restore", "discard"],
    sync: ["read", "request"],
    audit: ["read"],
  }),
  admin: ac.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    attorney: ["read", "create", "update"],
    publication: ["read", "review", "archive", "restore", "discard"],
    sync: ["read", "request"],
    audit: ["read"],
  }),
  member: ac.newRole({
    attorney: ["read"],
    publication: ["read", "review", "archive", "restore"],
    sync: ["read"],
  }),
  viewer: ac.newRole({
    attorney: ["read"],
    publication: ["read"],
    sync: ["read"],
  }),
};

export type RoleName = keyof typeof roles;
export const ROLE_NAMES = Object.keys(roles) as RoleName[];

/** O Better Auth guarda vários papéis como "admin,member". Papéis desconhecidos não concedem nada. */
export function parseRoles(role: string | null | undefined): RoleName[] {
  return (role ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is RoleName => Object.hasOwn(roles, r)); // hasOwn: "constructor"/"__proto__" não são papéis
}

export function can<R extends Resource>(
  role: string | null | undefined,
  resource: R,
  action: Action<R>,
): boolean {
  return parseRoles(role).some(
    (r) =>
      (roles[r].statements as Record<string, readonly string[]>)[resource]?.includes(
        action,
      ) ?? false,
  );
}

/** Lista "recurso:ação" concedida a um papel (exposta ao front para mostrar/ocultar controles). */
export function permissionsOf(role: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const r of parseRoles(role))
    for (const [res, acts] of Object.entries(roles[r].statements))
      for (const a of acts as readonly string[]) out.add(`${res}:${a}`);
  return [...out].sort();
}
