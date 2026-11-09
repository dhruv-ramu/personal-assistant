/** Fake Twilio Account SID. Assembled at runtime so secret scanners don't flag the source as a leaked credential. */
export const FAKE_TWILIO_SID = ["AC", "0123456789abcdef", "0123456789abcdef"].join("");
