import { sendTest, telegramStatus } from "@/lib/notify/telegram";
import { ok, fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether alerts are wired up. Never returns the token itself. */
export async function GET() {
  try {
    return ok(await telegramStatus(), { fetchedAt: Date.now(), degraded: false });
  } catch (err) {
    return fail(err);
  }
}

/** Send a test card, so the user can confirm delivery from Settings. */
export async function POST() {
  try {
    const status = await telegramStatus();
    if (!status.configured || !status.chatResolved) {
      return ok({ sent: false, ...status }, { fetchedAt: Date.now(), degraded: true });
    }
    return ok({ sent: await sendTest(), ...status }, { fetchedAt: Date.now(), degraded: false });
  } catch (err) {
    return fail(err);
  }
}
