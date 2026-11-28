// AWS Lambda's Node 22 runtime supplies the native AWS SDK. No cloud keys are bundled.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export function reminderEmail(event, env = process.env) {
  const origin = new URL(env.DAYMARK_APP_URL);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) throw new Error("Invalid application origin");
  if (!event || typeof event.title !== "string" || event.title.length > 200 || /[\r\n]/.test(event.title)
    || !/^[A-Za-z0-9_-]{32,64}$/.test(event.token) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(event.recipient)
    || !Number.isFinite(Date.parse(event.startsAt))) throw new Error("Invalid booking reminder");
  const link = new URL("/booking/" + event.token, origin.origin).href;
  if (!env.NEANDER_EMAIL_FROM || !env.AWS_SES_CONFIGURATION_SET) throw new Error("Managed email not ready");
  return { FromEmailAddress: env.NEANDER_EMAIL_FROM, ConfigurationSetName: env.AWS_SES_CONFIGURATION_SET,
    Destination: { ToAddresses: [event.recipient] },
    Content: { Simple: { Subject: { Data: "Meeting reminder: " + event.title, Charset: "UTF-8" },
      Body: { Text: { Data: "Your meeting starts at " + event.startsAt + ".\n\nOpen your booking details:\n" + link, Charset: "UTF-8" } } } },
  };
}

export async function handler(event) {
  const client = new SESv2Client({ maxAttempts: 1 });
  try {
    const result = await client.send(new SendEmailCommand(reminderEmail(event)));
    console.info(JSON.stringify({ bookingId: event.bookingId, status: "ses-accepted", messageId: result.MessageId }));
    return { messageId: result.MessageId };
  } finally { client.destroy(); }
}
