/**
 * Prints a one-time invite link for an administrator (first-run bootstrap: there is no sign-up).
 *
 *   pnpm --filter @managealltv/server admin:invite -- --email a@b.c --name 'Ad Soyad' [--force]
 *
 * Refuses when an active admin already exists, unless --force (e.g. every admin lost access).
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { prisma } from "../db";
import { HttpError } from "../lib/errors";
import { auditAs } from "../services/audit";
import { createInvite } from "../services/invites";

const USAGE = "Kullanım: pnpm --filter @managealltv/server admin:invite -- --email <e-posta> --name '<Ad Soyad>' [--force]";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // pnpm forwards a literal "--" separator to the script; parseArgs would treat the rest as positionals.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  let values: { email?: string; name?: string; force?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        email: { type: "string" },
        name: { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const email = z.email().safeParse(values.email?.trim());
  if (!email.success) fail(`Geçerli bir --email verin.\n${USAGE}`);
  const name = values.name?.trim() ?? "";
  if (name.length === 0 || name.length > 100) fail(`--name 1-100 karakter olmalı.\n${USAGE}`);

  const activeAdmins = await prisma.user.count({ where: { role: "admin", disabled: false } });
  if (activeAdmins > 0 && values.force !== true) {
    fail(`Zaten ${activeAdmins} etkin yönetici var. Yeni kullanıcıları panelden davet edin; yine de devam etmek için --force kullanın.`);
  }

  const { link, invite } = await createInvite({ name, email: email.data, role: "admin", locationIds: [] }, null);
  await auditAs(
    { userId: null, ip: null },
    {
      action: "user.invite",
      entityType: "invite",
      entityId: invite.id,
      summary: `"${invite.name}" (${invite.email}) komut satırından yönetici olarak davet edildi`,
    },
  );

  process.stdout.write(
    [
      `Yönetici daveti oluşturuldu: ${invite.name} <${invite.email}>`,
      "",
      `  ${link.url}`,
      "",
      `Bağlantı tek kullanımlıktır ve ${new Date(link.expiresAt).toLocaleString("tr-TR")} tarihine kadar geçerlidir.`,
      "",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof HttpError) fail(error.message);
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
