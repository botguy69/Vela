import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";

/** Single-desk recover: overwrite credential password for an existing email. */
export const recoverDeskPassword = createServerFn({ method: "POST" })
  .inputValidator((d: { email?: string; password?: string }) => d)
  .handler(async ({ data }) => {
    const email = String(data?.email ?? "").trim().toLowerCase();
    const password = String(data?.password ?? "");
    if (!email || !email.includes("@")) throw new Error("Need the desk email.");
    if (password.length < 8) throw new Error("Password must be at least 8 characters.");

    const sql = await getSql();
    const users = await sql.query<{ id: string }>(
      `select id from "user" where lower(email) = $1 limit 1`,
      [email],
    );
    if (!users[0]) throw new Error("No desk for that email on this host.");

    const { hashPassword } = await import("better-auth/crypto");
    const hash = await hashPassword(password);
    const uid = users[0].id;
    const acc = await sql.query<{ id: string }>(
      `select id from "account" where "userId" = $1 and "providerId" = 'credential' limit 1`,
      [uid],
    );
    if (acc[0]) {
      await sql.query(
        `update "account" set password = $1, "updatedAt" = now() where id = $2`,
        [hash, acc[0].id],
      );
    } else {
      const id = `cred_${uid}`;
      await sql.query(
        `insert into "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         values ($1, $2, 'credential', $2, $3, now(), now())`,
        [id, uid, hash],
      );
    }
    return { ok: true as const };
  });
