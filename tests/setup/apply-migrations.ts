import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Real checked-in migrations, applied to each test file's isolated D1 storage.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_RESTORE, env.TEST_MIGRATIONS);
