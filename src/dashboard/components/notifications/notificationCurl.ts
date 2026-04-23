/**
 * cURL builder + live-URL resolver for the notification log "Reproduce
 * request" panel. Storage keeps webhook URLs redacted, so when copying we
 * swap the redacted URL back for the live one from the channel doc — the
 * clipboard payload then matches what the provider actually saw.
 */
import type {
  ApiChannel,
  ApiNotificationLogRequest,
} from "../../types/notifications";

export function buildCurl(req: ApiNotificationLogRequest): string {
  const parts: string[] = [`curl -X ${shellEscape(req.method)}`];
  parts.push(`  ${shellEscape(req.url)}`);
  for (const [name, value] of Object.entries(req.headers)) {
    parts.push(`  -H ${shellEscape(`${name}: ${value}`)}`);
  }
  if (req.body) {
    parts.push(`  -d ${shellEscape(req.body)}`);
  }
  return parts.join(" \\\n");
}

function shellEscape(s: string): string {
  // POSIX single-quote, with the standard close/escape/reopen trick for
  // embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function resolveLiveUrl(channel: ApiChannel | null): string | null {
  if (!channel) return null;
  switch (channel.type) {
    case "discord":
      return channel.discordWebhookUrl ?? null;
    case "slack":
      return channel.slackWebhookUrl ?? null;
    case "webhook":
      return channel.webhookUrl ?? null;
    default:
      return null;
  }
}
