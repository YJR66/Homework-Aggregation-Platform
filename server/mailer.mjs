import nodemailer from 'nodemailer';

/** SMTP always uses TLS: implicit TLS or mandatory STARTTLS, with normal certificate checks. */
export async function sendSmtpMail(settings, password, message) {
  const transport = nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.secure,
    requireTLS: !settings.secure,
    auth: { user: settings.username, pass: password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  try {
    return await transport.sendMail({
      from: settings.from, to: settings.to, subject: message.subject, text: message.text,
      disableFileAccess: true, disableUrlAccess: true,
    });
  } finally { transport.close(); }
}
