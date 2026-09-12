// email.js — sends the merchant (not the customer — this changed) a digest
// whenever new alerts fire. This matches what was actually pitched:
// "tell me when this supplier is slipping," not automated customer emails.
// Customer-facing emails are a reasonable v2 addition, intentionally left
// out of this lightweight v1.

const sgMail = require("@sendgrid/mail");

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function sendAlertEmail(toEmail, alerts) {
  if (!alerts || alerts.length === 0) return { skipped: true };

  const subject =
    alerts.length === 1
      ? "Order Trust: 1 new alert"
      : `Order Trust: ${alerts.length} new alerts`;

  const bodyLines = alerts.map((a, i) => `${i + 1}. ${a.message}`);
  const text = `Here's what needs a look:\n\n${bodyLines.join("\n\n")}\n\nOpen your dashboard for details.`;

  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[EMAIL - not sent, no API key] To: ${toEmail} | ${subject}\n${text}`);
    return { skipped: true, reason: "no_api_key" };
  }

  await sgMail.send({
    to: toEmail,
    from: process.env.FROM_EMAIL,
    subject,
    text,
  });

  return { sent: true };
}

module.exports = { sendAlertEmail };
