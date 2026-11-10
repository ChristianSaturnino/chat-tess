import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['*.token', '*.accessToken', '*.refreshToken', '*.apiKey', '*.authorization'], censor: '[redacted]' },
});
