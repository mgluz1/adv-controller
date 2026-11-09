import { sql } from "drizzle-orm";
import type { Db, Tx } from "./types.ts";

/**
 * ÚNICO caminho para ler ou gravar dados de um escritório.
 *
 * Abre uma transação, fixa o escritório ativo (`app.organization_id`, local à transação) e troca para
 * o papel `adv_app`, sujeito às políticas de RLS. Mesmo um bug de consulta (WHERE esquecido) não
 * consegue ler nem gravar linhas de outro escritório. O `organizationId` deve vir da sessão
 * autenticada e de uma associação revalidada (ver routes/context.ts), nunca do corpo da requisição.
 */
export async function withTenant<T>(
  db: Db,
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof organizationId !== "string" || organizationId.length === 0 || organizationId.length > 128)
    throw new Error("withTenant: organizationId inválido.");
  return db.transaction(async (tx) => {
    // set_config(..., true) = local à transação; parametrizado (sem concatenação de SQL).
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    await tx.execute(sql`set local role adv_app`);
    return fn(tx);
  });
}
