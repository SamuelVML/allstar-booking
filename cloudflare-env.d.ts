declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ADMIN_EMAILS?: string;
    RESEND_API_KEY?: string;
    BOOKING_EMAIL_FROM?: string;
    BOOKING_EMAIL_REPLY_TO?: string;
    BOOKING_ADMIN_EMAIL?: string;
    BOOKING_BUSINESS_NAME?: string;
  }
}
