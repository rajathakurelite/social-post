/**
 * Lightweight structured console logger for scripts and skills.
 * Timestamps every line for operational debugging.
 */

function ts() {
  return new Date().toISOString();
}

export const logger = {
  /** General informational messages. */
  info(message, meta) {
    if (meta !== undefined) console.log(`[${ts()}] [INFO]`, message, meta);
    else console.log(`[${ts()}] [INFO]`, message);
  },

  /** Errors and failures (still throws upstream; this is for logging). */
  error(message, err) {
    if (err !== undefined) console.error(`[${ts()}] [ERROR]`, message, err);
    else console.error(`[${ts()}] [ERROR]`, message);
  },

  /** Positive completion (posted, generated, etc.). */
  success(message, meta) {
    if (meta !== undefined) console.log(`[${ts()}] [SUCCESS]`, message, meta);
    else console.log(`[${ts()}] [SUCCESS]`, message);
  },
};
