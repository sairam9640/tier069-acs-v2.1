const crypto = require('crypto');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

/**
 * Configure Nodemailer Transporter using environment variables (No Hardcoding)
 */
function getTransporter() {
  if (!nodemailer) {
    return null;
  }

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = (process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
  const pass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  // System sendmail fallback if SMTP not configured
  try {
    return nodemailer.createTransport({
      sendmail: true,
      newline: 'unix',
      path: '/usr/sbin/sendmail'
    });
  } catch (e) {
    return null;
  }
}

/**
 * Verify SMTP Connection on Server Startup
 */
async function verifySmtpConnection() {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[EMAIL SERVICE] No SMTP credentials configured. Email service will run in fallback mode.');
    return false;
  }

  try {
    if (typeof transporter.verify === 'function') {
      await transporter.verify();
      const host = process.env.SMTP_HOST || 'smtp.gmail.com';
      const port = process.env.SMTP_PORT || '587';
      const user = (process.env.SMTP_USER || process.env.GMAIL_USER || '').replace(/(.{3})(.*)(@.*)/, '$1***$3');
      console.log(`✅ [SMTP CONNECTED] Gmail SMTP connection verified successfully on ${host}:${port} (${user})`);
      return true;
    }
  } catch (err) {
    console.error(`⚠️ [SMTP WARNING] SMTP connection verification failed:`, err.message);
    return false;
  }
  return true;
}

/**
 * Generate Professional Responsive HTML Email Template with VRV ACS Branding
 */
function generateOtpEmailTemplate(otp, adminName = 'Super Admin') {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VRV ACS Super Admin Authentication</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f3f4f6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0b0f19; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #111827; border: 1px solid #1f2937; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%); padding: 32px 30px; text-align: center; border-bottom: 1px solid #1e293b;">
              <div style="display: inline-block; width: 64px; height: 64px; line-height: 64px; background: rgba(59, 130, 246, 0.15); border: 2px solid #3b82f6; border-radius: 50%; font-size: 30px; margin-bottom: 12px;">
                🔐
              </div>
              <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: 0.5px;">VRV ACS Cloud Platform</h1>
              <p style="margin: 6px 0 0 0; font-size: 13px; color: #93c5fd; font-weight: 500;">Super Admin OTP Authentication</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 30px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 24px; color: #e5e7eb;">
                Hello <strong>${adminName}</strong>,
              </p>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 22px; color: #9ca3af;">
                A secure login attempt was initiated for your Super Admin account. Use the one-time verification code below to access the SaaS Command Center:
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
                <tr>
                  <td align="center" style="background: #1f2937; border: 1px dashed #3b82f6; border-radius: 12px; padding: 24px 16px;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #60a5fa; font-weight: 700; margin-bottom: 8px;">
                      Your Single-Use Verification Code
                    </div>
                    <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; font-size: 38px; font-weight: 900; letter-spacing: 12px; color: #38bdf8; padding-left: 12px;">
                      ${otp}
                    </div>
                    <div style="font-size: 12px; color: #f87171; margin-top: 10px; font-weight: 600;">
                      ⏱️ Expires in 5 minutes (Single-Use Only)
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Security Notice -->
              <div style="background-color: rgba(239, 68, 68, 0.08); border-left: 4px solid #ef4444; padding: 14px 16px; border-radius: 4px; margin: 24px 0 0 0;">
                <p style="margin: 0; font-size: 12px; line-height: 18px; color: #fca5a5;">
                  <strong>Security Notice:</strong> If you did not initiate this request, please disregard this email. Your account remains protected as long as this OTP is kept confidential.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0d131f; padding: 20px 30px; text-align: center; border-top: 1px solid #1f2937;">
              <p style="margin: 0; font-size: 12px; color: #6b7280;">
                VRV ACS Cloud • Enterprise TR-069 Management Platform • <a href="http://ciniplay.in" style="color: #3b82f6; text-decoration: none;">ciniplay.in</a>
              </p>
              <p style="margin: 6px 0 0 0; font-size: 11px; color: #4b5563;">
                Automated security notification sent from VRV ACS Mailer. Please do not reply directly.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Reusable EmailService: sendOTP(email, otp, name)
 */
async function sendOTP(targetEmail, otp, adminName = 'Super Admin') {
  const cleanEmail = String(targetEmail).toLowerCase().trim();
  const maskedEmail = cleanEmail.replace(/(.{3})(.*)(@.*)/, '$1***$3');
  const fromAddress = process.env.SMTP_FROM || `"VRV ACS" <${process.env.SMTP_USER || 'bsnlott1@gmail.com'}>`;

  const mailOptions = {
    from: fromAddress,
    to: cleanEmail,
    subject: `🔐 VRV ACS Super Admin Login OTP: ${otp}`,
    text: `Your VRV ACS Super Admin verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`,
    html: generateOtpEmailTemplate(otp, adminName)
  };

  const transporter = getTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ [EMAIL DISPATCHED] OTP successfully sent to ${maskedEmail} via Gmail SMTP (MessageId: ${info.messageId || 'OK'})`);
      return { success: true, messageId: info.messageId };
    } catch (err) {
      console.error(`⚠️ [EMAIL ERROR] Failed to dispatch OTP to ${maskedEmail}:`, err.message);
      return { success: false, error: 'Email delivery failed' };
    }
  }

  return { success: false, error: 'No active SMTP transporter configured' };
}

const sendSuperAdminOtpEmail = sendOTP;

module.exports = {
  getTransporter,
  verifySmtpConnection,
  sendOTP,
  sendSuperAdminOtpEmail
};
