import type { AppContext } from "../context";
import type { Env } from "../env";
import type { SessionRow } from "../security/sessions";

export interface AppEnvBindings {
  Bindings: Env;
  Variables: {
    app: AppContext;
    session: SessionRow | null;
    sessionToken: string | null;
    selfFetch: (req: Request) => Promise<Response>;
  };
}
